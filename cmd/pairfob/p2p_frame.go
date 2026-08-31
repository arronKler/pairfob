package main

import (
	"encoding/binary"
	"errors"
)

const (
	p2pChunkHeaderBytes = 12
	p2pChunkDataBytes   = 16*1024 - p2pChunkHeaderBytes
	p2pMaxFrameBytes    = 24 + 262144
)

var p2pChunkMagic = [4]byte{'P', 'F', 'P', '2'}

func splitP2PFrame(frame []byte) ([][]byte, error) {
	if len(frame) < 24 || len(frame) > p2pMaxFrameBytes {
		return nil, errors.New("invalid P2P frame length")
	}
	chunks := make([][]byte, 0, (len(frame)+p2pChunkDataBytes-1)/p2pChunkDataBytes)
	for offset := 0; offset < len(frame); offset += p2pChunkDataBytes {
		end := min(offset+p2pChunkDataBytes, len(frame))
		chunk := make([]byte, p2pChunkHeaderBytes+end-offset)
		copy(chunk[:4], p2pChunkMagic[:])
		binary.BigEndian.PutUint32(chunk[4:8], uint32(len(frame)))
		binary.BigEndian.PutUint32(chunk[8:12], uint32(offset))
		copy(chunk[p2pChunkHeaderBytes:], frame[offset:end])
		chunks = append(chunks, chunk)
	}
	return chunks, nil
}

type p2pFrameAssembler struct {
	total int
	data  []byte
}

func (a *p2pFrameAssembler) Push(chunk []byte) ([]byte, error) {
	if len(chunk) <= p2pChunkHeaderBytes || len(chunk) > p2pChunkHeaderBytes+p2pChunkDataBytes ||
		string(chunk[:4]) != string(p2pChunkMagic[:]) {
		return nil, errors.New("invalid P2P chunk")
	}
	total := int(binary.BigEndian.Uint32(chunk[4:8]))
	offset := int(binary.BigEndian.Uint32(chunk[8:12]))
	if total < 24 || total > p2pMaxFrameBytes || offset < 0 || offset >= total || offset+len(chunk)-p2pChunkHeaderBytes > total {
		return nil, errors.New("invalid P2P chunk bounds")
	}
	if offset == 0 {
		if len(a.data) != 0 {
			return nil, errors.New("interleaved P2P frame")
		}
		a.total = total
		a.data = make([]byte, 0, total)
	}
	if a.total != total || offset != len(a.data) {
		return nil, errors.New("out-of-order P2P chunk")
	}
	a.data = append(a.data, chunk[p2pChunkHeaderBytes:]...)
	if len(a.data) != a.total {
		return nil, nil
	}
	frame := a.data
	a.total, a.data = 0, nil
	return frame, nil
}
