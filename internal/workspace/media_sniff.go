package workspace

import (
	"bytes"
	"encoding/binary"
	"strings"
)

func sniffMedia(head []byte, size int64) (kind, mime string, width, height int) {
	if looksLikeSVG(head) {
		return MediaDownload, "image/svg+xml", 0, 0
	}
	if bytes.HasPrefix(head, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		width, height = pngSize(head)
		return MediaImage, "image/png", width, height
	}
	if bytes.HasPrefix(head, []byte{0xff, 0xd8, 0xff}) {
		width, height = jpegSize(head)
		return MediaImage, "image/jpeg", width, height
	}
	if bytes.HasPrefix(head, []byte("GIF87a")) || bytes.HasPrefix(head, []byte("GIF89a")) {
		width, height = gifSize(head)
		return MediaImage, "image/gif", width, height
	}
	if len(head) >= 12 && bytes.Equal(head[:4], []byte("RIFF")) && bytes.Equal(head[8:12], []byte("WEBP")) {
		width, height = webpSize(head)
		return MediaImage, "image/webp", width, height
	}
	if len(head) >= 12 && bytes.Equal(head[:4], []byte("RIFF")) && bytes.Equal(head[8:12], []byte("WAVE")) {
		return MediaAudio, "audio/wav", 0, 0
	}
	if bytes.HasPrefix(head, []byte("fLaC")) {
		return MediaAudio, "audio/flac", 0, 0
	}
	if bytes.HasPrefix(head, []byte("OggS")) {
		return sniffOgg(head)
	}
	if bytes.HasPrefix(head, []byte("ID3")) || mpegAudioFrame(head) {
		return MediaAudio, "audio/mpeg", 0, 0
	}
	if aacADTS(head) {
		return MediaAudio, "audio/aac", 0, 0
	}
	if len(head) >= 12 && bytes.Equal(head[4:8], []byte("ftyp")) {
		return sniffISO(head)
	}
	if bytes.HasPrefix(head, []byte{0x1a, 0x45, 0xdf, 0xa3}) {
		return MediaVideo, "video/webm", 0, 0
	}
	if size == 0 {
		return MediaDownload, "application/octet-stream", 0, 0
	}
	return MediaDownload, "application/octet-stream", 0, 0
}

func looksLikeSVG(head []byte) bool {
	trimmed := bytes.TrimSpace(bytes.TrimPrefix(head, []byte{0xef, 0xbb, 0xbf}))
	if bytes.HasPrefix(trimmed, []byte("<svg")) || bytes.HasPrefix(trimmed, []byte("<SVG")) {
		return true
	}
	if !bytes.HasPrefix(trimmed, []byte("<?xml")) && !bytes.HasPrefix(trimmed, []byte("<?XML")) {
		return false
	}
	limit := trimmed
	if len(limit) > 512 {
		limit = limit[:512]
	}
	lower := bytes.ToLower(limit)
	return bytes.Contains(lower, []byte("<svg"))
}

func pngSize(head []byte) (int, int) {
	if len(head) < 24 || !bytes.Equal(head[12:16], []byte("IHDR")) {
		return 0, 0
	}
	return int(binary.BigEndian.Uint32(head[16:20])), int(binary.BigEndian.Uint32(head[20:24]))
}

func gifSize(head []byte) (int, int) {
	if len(head) < 10 {
		return 0, 0
	}
	return int(binary.LittleEndian.Uint16(head[6:8])), int(binary.LittleEndian.Uint16(head[8:10]))
}

func jpegSize(head []byte) (int, int) {
	i := 2
	for i+8 < len(head) {
		if head[i] != 0xff {
			i++
			continue
		}
		marker := head[i+1]
		if marker == 0xd8 || marker == 0xd9 || (marker >= 0xd0 && marker <= 0xd7) {
			i += 2
			continue
		}
		if i+3 >= len(head) {
			return 0, 0
		}
		seglen := int(binary.BigEndian.Uint16(head[i+2 : i+4]))
		if seglen < 2 {
			return 0, 0
		}
		if marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc {
			if i+8 >= len(head) {
				return 0, 0
			}
			return int(binary.BigEndian.Uint16(head[i+7 : i+9])), int(binary.BigEndian.Uint16(head[i+5 : i+7]))
		}
		i += 2 + seglen
	}
	return 0, 0
}

func webpSize(head []byte) (int, int) {
	if len(head) < 30 {
		return 0, 0
	}
	chunk := head[12:16]
	switch {
	case bytes.Equal(chunk, []byte("VP8X")) && len(head) >= 30:
		w := 1 + int(head[24]) + int(head[25])<<8 + int(head[26])<<16
		h := 1 + int(head[27]) + int(head[28])<<8 + int(head[29])<<16
		return w, h
	case bytes.Equal(chunk, []byte("VP8 ")) && len(head) >= 30:
		payload := head[20:]
		if len(payload) >= 10 && payload[3] == 0x9d && payload[4] == 0x01 && payload[5] == 0x2a {
			return int(binary.LittleEndian.Uint16(payload[6:8])) & 0x3fff, int(binary.LittleEndian.Uint16(payload[8:10])) & 0x3fff
		}
	case bytes.Equal(chunk, []byte("VP8L")) && len(head) >= 25 && head[20] == 0x2f:
		bits := uint32(head[21]) | uint32(head[22])<<8 | uint32(head[23])<<16 | uint32(head[24])<<24
		return int(bits&0x3fff) + 1, int((bits>>14)&0x3fff) + 1
	}
	return 0, 0
}

func sniffOgg(head []byte) (string, string, int, int) {
	lower := bytes.ToLower(head)
	if bytes.Contains(lower, []byte("theora")) {
		return MediaVideo, "video/ogg", 0, 0
	}
	return MediaAudio, "audio/ogg", 0, 0
}

func sniffISO(head []byte) (string, string, int, int) {
	brand := ""
	if len(head) >= 12 {
		brand = string(head[8:12])
	}
	switch strings.TrimSpace(brand) {
	case "M4A", "M4B", "M4P":
		return MediaAudio, "audio/mp4", 0, 0
	case "qt":
		return MediaVideo, "video/quicktime", 0, 0
	default:
		return MediaVideo, "video/mp4", 0, 0
	}
}

func mpegAudioFrame(head []byte) bool {
	if len(head) < 2 {
		return false
	}
	// 11-bit sync (0xFFF), a non-reserved MPEG version, and a real audio layer.
	// ADTS AAC reuses the 0xFFF sync but always carries layer bits 0b00; requiring
	// a non-zero layer routes those headers to aacADTS and rejects the reserved
	// MPEG layer, while every actual MP3 frame (Layer I/II/III) still matches.
	return head[0] == 0xff && head[1]&0xe0 == 0xe0 && head[1]&0x18 != 0x08 && head[1]&0x06 != 0x00
}

func aacADTS(head []byte) bool {
	if len(head) < 2 {
		return false
	}
	return head[0] == 0xff && head[1]&0xf6 == 0xf0
}

func mediaCap(kind string) int64 {
	if kind == MediaImage {
		return MaxMediaImageBytes
	}
	return MaxMediaBytes
}

func pixelBoundsOK(kind string, width, height int) bool {
	if kind != MediaImage {
		return true
	}
	if width <= 0 || height <= 0 {
		return false
	}
	if width > MaxMediaDimension || height > MaxMediaDimension {
		return false
	}
	return width*height <= MaxMediaPixels
}

type jpegDimParser struct {
	buf  []byte
	w, h int
}

func (p *jpegDimParser) Write(b []byte) (int, error) {
	n := len(b)
	if p.w > 0 && p.h > 0 || len(p.buf) >= MaxMediaImageBytes {
		return n, nil
	}
	if len(p.buf)+len(b) > MaxMediaImageBytes {
		b = b[:MaxMediaImageBytes-len(p.buf)]
	}
	p.buf = append(p.buf, b...)
	p.w, p.h = jpegSize(p.buf)
	if p.w > 0 && p.h > 0 {
		p.buf = nil
	}
	return n, nil
}

func (p *jpegDimParser) size() (int, int) {
	if p.w > 0 && p.h > 0 {
		return p.w, p.h
	}
	return jpegSize(p.buf)
}
