import AppKit
import ScreenCaptureKit

final class Pattern: NSView {
    private var light = false

    func start(fps: Int) {
        wantsLayer = true
        guard let layer else { fail("Missing test window layer") }
        layer.backgroundColor = NSColor.black.cgColor
        let marker = CALayer()
        marker.frame = CGRect(x: 0, y: 8, width: 20, height: 8)
        marker.backgroundColor = NSColor.systemBlue.cgColor
        layer.addSublayer(marker)
        let motion = CABasicAnimation(keyPath: "position.x")
        motion.fromValue = 10
        motion.toValue = bounds.width - 10
        motion.duration = 2
        motion.repeatCount = .infinity
        motion.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: Float(fps), preferred: Float(fps))
        marker.add(motion, forKey: "probe-motion")
    }

    func flip(id: UInt32, readAt: UInt64, trace: FlipTrace) {
        let drawAt = DispatchTime.now().uptimeNanoseconds
        light.toggle()
        trace.arm(FlipTiming(id: id, readAt: readAt, drawAt: drawAt, light: light))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer?.backgroundColor = (light ? NSColor.white : NSColor.black).cgColor
        CATransaction.commit()
        CATransaction.flush()
    }
}

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    let trace = FlipTrace()
    let encoder: Encoder
    init(_ encoder: Encoder) { self.encoder = encoder }
    func stream(_ stream: SCStream, didStopWithError error: Error) { fail(error.localizedDescription) }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard let info = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]])?.first,
            info[.status] as? Int == SCFrameStatus.complete.rawValue,
            let image = sample.imageBuffer else { return }
        encoder.encode(image, pts: sample.presentationTimeStamp, flip: trace.match(image))
    }
}

@main
struct Probe {
    @MainActor static func main() {
        let fps = CommandLine.arguments.dropFirst().first == "120" ? 120 : 60
        let (w, h) = fps == 120 ? (1280, 720) : (1920, 1080)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let window = NSWindow(contentRect: NSRect(x: 20, y: 100, width: 640, height: 360),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.hasShadow = false
        window.level = .floating
        let pattern = Pattern(frame: window.contentView!.bounds)
        window.contentView = pattern
        pattern.start(fps: fps)
        window.orderFrontRegardless()
        let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "Interactive capture benchmark")
        Task { @MainActor in
            do {
                let content = try await SCShareableContent.currentProcess
                guard let target = content.windows.first(where: { $0.windowID == CGWindowID(window.windowNumber) })
                    else { fail("Test window unavailable in graphical login session") }
                let config = SCStreamConfiguration()
                config.width = w
                config.height = h
                config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(fps))
                config.queueDepth = 3
                config.showsCursor = false
                config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
                config.ignoreShadowsSingleWindow = true
                let capture = Capture(Encoder(width: w, height: h, fps: fps))
                let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: target),
                    configuration: config, delegate: capture)
                try stream.addStreamOutput(capture, type: .screen, sampleHandlerQueue: DispatchQueue(label: "probe.capture"))
                try await stream.startCapture()
                FileHandle.standardError.write(Data("ScreenCaptureKit + hardware H.264 active (\(w)x\(h), target \(fps) fps)\n".utf8))
                let trace = capture.trace
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    DispatchQueue.global().async {
                        while let line = readLine() {
                            if let id = UInt32(line), id > 0 {
                                let readAt = DispatchTime.now().uptimeNanoseconds
                                DispatchQueue.main.async { pattern.flip(id: id, readAt: readAt, trace: trace) }
                            }
                        }
                        continuation.resume()
                    }
                }
                try await stream.stopCapture()
                withExtendedLifetime((capture, window, activity)) {}
                exit(0)
            } catch { fail(error.localizedDescription) }
        }
        app.run()
    }
}
