// HTTP server for MP3 concatenation using FFmpeg
// Designed to run in a Cloudflare Container
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// ConcatRequest is the request body for /concat endpoint
type ConcatRequest struct {
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
	http.HandleFunc("/concat", handleConcat)
	http.HandleFunc("/health", handleHealth)

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

	// Create temp directory for this request
	workDir, err := os.MkdirTemp("", "concat-*")
	if err != nil {
		sendError(w, fmt.Sprintf("Failed to create temp dir: %v", err), http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(workDir)

	// Download all segments
	fmt.Printf("Downloading %d segments...\n", len(req.Segments))
	listFile := filepath.Join(workDir, "list.txt")
	listContent := ""

	for i, url := range req.Segments {
		segmentPath := filepath.Join(workDir, fmt.Sprintf("segment_%04d.mp3", i))
		if err := downloadFile(url, segmentPath); err != nil {
			sendError(w, fmt.Sprintf("Failed to download segment %d: %v", i, err), http.StatusInternalServerError)
			return
		}
		// FFmpeg concat format requires 'file' directive
		listContent += fmt.Sprintf("file '%s'\n", segmentPath)
	}

	if err := os.WriteFile(listFile, []byte(listContent), 0644); err != nil {
		sendError(w, fmt.Sprintf("Failed to write list file: %v", err), http.StatusInternalServerError)
		return
	}

	// Run FFmpeg to concatenate
	outputPath := filepath.Join(workDir, "output.mp3")
	fmt.Println("Running FFmpeg concatenation...")

	args := []string{
		"-f", "concat",
		"-safe", "0",
		"-i", listFile,
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

	cmd := exec.Command("ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		sendError(w, fmt.Sprintf("FFmpeg failed: %v\nStderr: %s", err, stderr.String()), http.StatusInternalServerError)
		return
	}

	// Get duration using ffprobe
	fmt.Println("Getting duration with ffprobe...")
	duration, err := getDuration(outputPath)
	if err != nil {
		fmt.Printf("Warning: Failed to get duration: %v\n", err)
		duration = 0
	}

	// Get file size
	fileInfo, err := os.Stat(outputPath)
	if err != nil {
		sendError(w, fmt.Sprintf("Failed to stat output file: %v", err), http.StatusInternalServerError)
		return
	}
	fileSize := fileInfo.Size()

	// Upload to output URL
	fmt.Println("Uploading result...")
	if err := uploadFile(outputPath, req.OutputURL); err != nil {
		sendError(w, fmt.Sprintf("Failed to upload result: %v", err), http.StatusInternalServerError)
		return
	}

	// Send success response
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ConcatResponse{
		Success:         true,
		DurationSeconds: duration,
		FileSize:        fileSize,
	})

	fmt.Printf("Successfully concatenated %d segments: %.2fs, %d bytes\n", len(req.Segments), duration, fileSize)
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
