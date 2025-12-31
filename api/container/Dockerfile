# Minimal FFmpeg container for MP3 concatenation
# Multi-stage build: Go binary + Alpine with FFmpeg
# Target size: ~60MB

# Stage 1: Build Go binary
FROM golang:1.22-alpine AS builder

WORKDIR /build
COPY go.mod .
COPY main.go .

# Build static binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server .

# Stage 2: Final minimal image
FROM alpine:3.20

# Install FFmpeg (includes ffprobe)
RUN apk add --no-cache ffmpeg

# Copy the Go binary from builder
COPY --from=builder /build/server /server

# Expose HTTP port
EXPOSE 8080

# Run the server
CMD ["/server"]
