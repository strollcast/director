// HTTP server for MP3 concatenation using FFmpeg
// Designed to run in a Cloudflare Container
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ---------- Container Status Types (T003-T006) ----------

// ContainerStatus represents the current state of the FFmpeg container
type ContainerStatus struct {
	State              string     `json:"state"`               // idle, processing, error
	JobID              string     `json:"job_id"`              // Episode ID of current job
	StartedAt          *time.Time `json:"started_at"`          // When processing started
	SegmentsTotal      int        `json:"segments_total"`      // Total segments to process
	SegmentsDownloaded int        `json:"segments_downloaded"` // Segments downloaded so far
	LastError          string     `json:"last_error"`          // Most recent error message
	LastHeartbeat      *time.Time `json:"last_heartbeat"`      // When last heartbeat was sent
}

// HeartbeatRequest is sent from container to Durable Object
type HeartbeatRequest struct {
	JobID    string  `json:"job_id"`
	State    string  `json:"state"`
	Progress float64 `json:"progress,omitempty"`
}

// HeartbeatResponse is returned by Durable Object
type HeartbeatResponse struct {
	Acknowledged    bool   `json:"acknowledged"`
	TimeoutExtended bool   `json:"timeout_extended"`
	Error           string `json:"error,omitempty"`
}

// StatusResponse matches ContainerStatus for JSON serialization
type StatusResponse = ContainerStatus

// Global container status with mutex for thread-safe access
var (
	containerStatus = ContainerStatus{State: "idle"}
	statusMutex     sync.RWMutex
	heartbeatStop   chan struct{}
	shutdownCtx     context.Context
	shutdownCancel  context.CancelFunc
)

// ---------- Existing Types ----------

// ConcatRequest is the request body for /concat endpoint
type ConcatRequest struct {
	EpisodeID string           `json:"episode_id"` // Episode ID for logging
	Segments  []string         `json:"segments"`   // Signed URLs for input MP3 files
	OutputURL string           `json:"output_url"` // Signed URL for uploading result
	Metadata  ConcatMetadata   `json:"metadata"`
}

// ConcatMetadata contains ID3 tag metadata
type ConcatMetadata struct {
	Title  string `json:"title"`
	Artist string `json:"artist"`
	Album  string `json:"album"`
	Genre  string `json:"genre"`
}

// ConcatResponse is the response body for /concat endpoint
type ConcatResponse struct {
	Success         bool    `json:"success"`
	DurationSeconds float64 `json:"duration_seconds"`
	FileSize        int64   `json:"file_size"`
	Error           string  `json:"error,omitempty"`
}

func main() {
	// Initialize shutdown context for graceful shutdown (US3)
	shutdownCtx, shutdownCancel = context.WithCancel(context.Background())

	// Setup signal handling for graceful shutdown (US3)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigChan
		fmt.Printf("Received signal %v, initiating graceful shutdown...\n", sig)
		shutdownCancel()
	}()

	http.HandleFunc("/concat", handleConcat)
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/status", handleStatus) // US2: Status endpoint

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	fmt.Printf("Starting server on port %s\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		fmt.Printf("Server error: %v\n", err)
		os.Exit(1)
	}
}

// ---------- Heartbeat Functions (US1: T009-T011) ----------

// sendHeartbeat sends a heartbeat to the Durable Object to renew activity timeout
func sendHeartbeat(jobID string, progress float64) error {
	heartbeatReq := HeartbeatRequest{
		JobID:    jobID,
		State:    "processing",
		Progress: progress,
	}

	body, err := json.Marshal(heartbeatReq)
	if err != nil {
		return fmt.Errorf("marshal heartbeat request: %w", err)
	}

	// POST to localhost (container's own endpoint, proxied to Durable Object)
	req, err := http.NewRequest(http.MethodPost, "http://localhost:8080/heartbeat", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create heartbeat request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("send heartbeat: %w", err)
	}
	defer resp.Body.Close()

	var heartbeatResp HeartbeatResponse
	if err := json.NewDecoder(resp.Body).Decode(&heartbeatResp); err != nil {
		return fmt.Errorf("decode heartbeat response: %w", err)
	}

	if !heartbeatResp.Acknowledged {
		return fmt.Errorf("heartbeat not acknowledged: %s", heartbeatResp.Error)
	}

	// Update last heartbeat timestamp
	statusMutex.Lock()
	now := time.Now()
	containerStatus.LastHeartbeat = &now
	statusMutex.Unlock()

	fmt.Printf("[%s] Heartbeat sent (progress: %.2f), timeout extended: %v\n", jobID, progress, heartbeatResp.TimeoutExtended)
	return nil
}

// startHeartbeat starts a goroutine that sends heartbeats every 2 minutes
func startHeartbeat(jobID string) {
	heartbeatStop = make(chan struct{})
	ticker := time.NewTicker(2 * time.Minute)

	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				// Calculate progress based on segments downloaded
				statusMutex.RLock()
				progress := 0.0
				if containerStatus.SegmentsTotal > 0 {
					progress = float64(containerStatus.SegmentsDownloaded) / float64(containerStatus.SegmentsTotal)
				}
				statusMutex.RUnlock()

				if err := sendHeartbeat(jobID, progress); err != nil {
					fmt.Printf("[%s] Heartbeat error: %v\n", jobID, err)
				}
			case <-heartbeatStop:
				fmt.Printf("[%s] Heartbeat stopped\n", jobID)
				return
			case <-shutdownCtx.Done():
				fmt.Printf("[%s] Heartbeat stopped due to shutdown\n", jobID)
				return
			}
		}
	}()
}

// stopHeartbeat signals the heartbeat goroutine to stop
func stopHeartbeat() {
	if heartbeatStop != nil {
		close(heartbeatStop)
		heartbeatStop = nil
	}
}

// ---------- Status Handler (US2: T019-T020) ----------

func handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		sendError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	statusMutex.RLock()
	status := containerStatus
	statusMutex.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleConcat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendError(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ConcatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendError(w, fmt.Sprintf("Invalid request body: %v", err), http.StatusBadRequest)
		return
	}

	if len(req.Segments) == 0 {
		sendError(w, "No segments provided", http.StatusBadRequest)
		return
	}

	if req.OutputURL == "" {
		sendError(w, "No output URL provided", http.StatusBadRequest)
		return
	}

	// T012: Update container status to "processing"
	now := time.Now()
	statusMutex.Lock()
	containerStatus = ContainerStatus{
		State:              "processing",
		JobID:              req.EpisodeID,
		StartedAt:          &now,
		SegmentsTotal:      len(req.Segments),
		SegmentsDownloaded: 0,
		LastError:          "",
		LastHeartbeat:      nil,
	}
	statusMutex.Unlock()

	// T013: Start heartbeat goroutine
	startHeartbeat(req.EpisodeID)

	// Helper to handle errors with status update
	handleError := func(message string, status int) {
		// T016: Stop heartbeat and set state to "error" on failure
		stopHeartbeat()
		statusMutex.Lock()
		containerStatus.State = "error"
		containerStatus.LastError = message
		statusMutex.Unlock()
		sendError(w, message, status)
	}

	// T017: Create context with 60-minute deadline to prevent zombie containers
	ctx, cancel := context.WithTimeout(shutdownCtx, 60*time.Minute)
	defer cancel()

	// Create temp directory for this request
	workDir, err := os.MkdirTemp("", "concat-*")
	if err != nil {
		handleError(fmt.Sprintf("Failed to create temp dir: %v", err), http.StatusInternalServerError)
		return
	}
	// T027: Cleanup temp directory (always, including on shutdown)
	defer func() {
		os.RemoveAll(workDir)
		fmt.Printf("[%s] Cleaned up temp directory: %s\n", req.EpisodeID, workDir)
	}()

	// Check for shutdown/timeout before starting
	select {
	case <-ctx.Done():
		handleError(fmt.Sprintf("Job cancelled: %v", ctx.Err()), http.StatusServiceUnavailable)
		return
	default:
	}

	// Download all segments
	fmt.Printf("[%s] Downloading %d segments...\n", req.EpisodeID, len(req.Segments))
	listFile := filepath.Join(workDir, "list.txt")
	listContent := ""

	for i, url := range req.Segments {
		// Check for shutdown/timeout during download
		select {
		case <-ctx.Done():
			handleError(fmt.Sprintf("Job cancelled during download: %v", ctx.Err()), http.StatusServiceUnavailable)
			return
		default:
		}

		segmentPath := filepath.Join(workDir, fmt.Sprintf("segment_%04d.mp3", i))
		if err := downloadFile(url, segmentPath); err != nil {
			handleError(fmt.Sprintf("Failed to download segment %d: %v", i, err), http.StatusInternalServerError)
			return
		}
		// FFmpeg concat format requires 'file' directive
		listContent += fmt.Sprintf("file '%s'\n", segmentPath)

		// T014: Update segments_downloaded count
		statusMutex.Lock()
		containerStatus.SegmentsDownloaded = i + 1
		statusMutex.Unlock()
	}
	fmt.Printf("[%s] Done: download.\n", req.EpisodeID)

	if err := os.WriteFile(listFile, []byte(listContent), 0644); err != nil {
		handleError(fmt.Sprintf("Failed to write list file: %v", err), http.StatusInternalServerError)
		return
	}

	// Run FFmpeg to concatenate and normalize
	outputPath := filepath.Join(workDir, "output.mp3")
	fmt.Printf("[%s] Running FFmpeg concatenation with volume normalization...\n", req.EpisodeID)

	args := []string{
		"-f", "concat",
		"-safe", "0",
		"-i", listFile,
		"-af", "loudnorm=I=-16:TP=-1.5:LRA=11", // Normalize to -16 LUFS (podcast standard)
		"-c:a", "libmp3lame",
		"-b:a", "128k",
		"-ar", "44100",
	}

	// Add metadata if provided
	if req.Metadata.Title != "" {
		args = append(args, "-metadata", fmt.Sprintf("title=%s", req.Metadata.Title))
	}
	if req.Metadata.Artist != "" {
		args = append(args, "-metadata", fmt.Sprintf("artist=%s", req.Metadata.Artist))
	}
	if req.Metadata.Album != "" {
		args = append(args, "-metadata", fmt.Sprintf("album=%s", req.Metadata.Album))
	}
	if req.Metadata.Genre != "" {
		args = append(args, "-metadata", fmt.Sprintf("genre=%s", req.Metadata.Genre))
	}

	args = append(args, "-y", outputPath)

	// T026: Use CommandContext to allow cancellation on shutdown/timeout
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// Check if it was a context cancellation
		if ctx.Err() != nil {
			handleError(fmt.Sprintf("FFmpeg cancelled: %v", ctx.Err()), http.StatusServiceUnavailable)
		} else {
			handleError(fmt.Sprintf("FFmpeg failed: %v\nStderr: %s", err, stderr.String()), http.StatusInternalServerError)
		}
		return
	}
	fmt.Printf("[%s] Done: FFmpeg concatenation and metadata to %s.\n", req.EpisodeID, outputPath)

	// Get duration using ffprobe
	fmt.Printf("[%s] Getting duration with ffprobe...\n", req.EpisodeID)
	duration, err := getDuration(outputPath)
	if err != nil {
		fmt.Printf("[%s] Warning: Failed to get duration: %v\n", req.EpisodeID, err)
		duration = 0
	}

	// Get file size
	fileInfo, err := os.Stat(outputPath)
	if err != nil {
		handleError(fmt.Sprintf("Failed to stat output file: %v", err), http.StatusInternalServerError)
		return
	}
	fileSize := fileInfo.Size()

	// Upload to output URL
	fmt.Printf("[%s] Uploading result to %s..\n", req.EpisodeID, req.OutputURL)
	if err := uploadFile(outputPath, req.OutputURL); err != nil {
		handleError(fmt.Sprintf("Failed to upload result: %v", err), http.StatusInternalServerError)
		return
	}
	fmt.Printf("[%s] Done: uploading result.\n", req.EpisodeID)

	// T015: Stop heartbeat and reset state to "idle" on success
	stopHeartbeat()
	statusMutex.Lock()
	containerStatus = ContainerStatus{
		State:              "idle",
		JobID:              "",
		StartedAt:          nil,
		SegmentsTotal:      0,
		SegmentsDownloaded: 0,
		LastError:          "",
		LastHeartbeat:      nil,
	}
	statusMutex.Unlock()

	// Send success response
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ConcatResponse{
		Success:         true,
		DurationSeconds: duration,
		FileSize:        fileSize,
	})

	fmt.Printf("[%s] Successfully concatenated and normalized %d segments: %.2fs, %d bytes\n", req.EpisodeID, len(req.Segments), duration, fileSize)
}

func downloadFile(url, destPath string) error {
	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("GET failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GET returned %d: %s", resp.StatusCode, string(body))
	}

	out, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("create file failed: %w", err)
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	if err != nil {
		return fmt.Errorf("copy failed: %w", err)
	}

	return nil
}

func uploadFile(srcPath, url string) error {
	file, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("open file failed: %w", err)
	}
	defer file.Close()

	fileInfo, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat file failed: %w", err)
	}

	req, err := http.NewRequest(http.MethodPut, url, file)
	if err != nil {
		return fmt.Errorf("create request failed: %w", err)
	}

	req.ContentLength = fileInfo.Size()
	req.Header.Set("Content-Type", "audio/mpeg")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("PUT failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("PUT returned %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

func getDuration(filePath string) (float64, error) {
	cmd := exec.Command("ffprobe",
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		filePath,
	)

	output, err := cmd.Output()
	if err != nil {
		return 0, err
	}

	durationStr := strings.TrimSpace(string(output))

	// Handle "N/A" or empty output
	if durationStr == "" || durationStr == "N/A" {
		return 0, fmt.Errorf("no duration found")
	}

	duration, err := strconv.ParseFloat(durationStr, 64)
	if err != nil {
		return 0, fmt.Errorf("parse duration failed: %w", err)
	}

	return duration, nil
}

func sendError(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(ConcatResponse{
		Success: false,
		Error:   message,
	})
	fmt.Printf("Error: %s\n", message)
}

// Unused but kept for future use
var _ = regexp.Compile
