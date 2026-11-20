package main

import (
	"net"

	"github.com/pion/webrtc/v4"
)

// Binding both candidate types to the advertised LAN address keeps the UDP
// path and lets clients try direct ICE-TCP when that path is filtered.
func mediaAPI(addr string) (*webrtc.API, func(), error) {
	if addr == "" {
		return webrtc.NewAPI(), func() {}, nil
	}
	tcp, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, nil, err
	}
	udp, err := net.ListenPacket("udp", tcp.Addr().String())
	if err != nil {
		tcp.Close()
		return nil, nil, err
	}
	tcpMux := webrtc.NewICETCPMux(nil, tcp, 64)
	udpMux := webrtc.NewICEUDPMux(nil, udp)
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{
		webrtc.NetworkTypeUDP4, webrtc.NetworkTypeTCP4,
		webrtc.NetworkTypeUDP6, webrtc.NetworkTypeTCP6,
	})
	settings.SetICETCPMux(tcpMux)
	settings.SetICEUDPMux(udpMux)
	return webrtc.NewAPI(webrtc.WithSettingEngine(settings)), func() {
		tcpMux.Close()
		udpMux.Close()
	}, nil
}
