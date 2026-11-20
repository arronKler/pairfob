import CoreVideo
import Foundation

// The capture and encoder queues may differ. A trace follows only the first
// frame whose centre luma confirms the requested change in the real window.
struct FlipTiming {
    let id: UInt32
    let readAt: UInt64
    let drawAt: UInt64
    let light: Bool
}

final class CapturedFlip {
    let input: FlipTiming
    let capturedAt: UInt64
    init(_ input: FlipTiming, at time: UInt64) {
        self.input = input
        capturedAt = time
    }
}

final class FlipTrace: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: FlipTiming?

    func arm(_ timing: FlipTiming) {
        lock.withLock { pending = timing }
    }

    func match(_ image: CVPixelBuffer) -> CapturedFlip? {
        lock.withLock {
            guard let input = pending,
                  CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else { return nil }
            defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
            guard let plane = CVPixelBufferGetBaseAddressOfPlane(image, 0) else { return nil }
            let row = CVPixelBufferGetHeightOfPlane(image, 0) / 2
            let column = CVPixelBufferGetWidthOfPlane(image, 0) / 2
            let luma = plane.load(fromByteOffset: row * CVPixelBufferGetBytesPerRowOfPlane(image, 0) + column, as: UInt8.self)
            guard input.light ? luma > 210 : luma < 44 else { return nil }
            pending = nil
            return CapturedFlip(input, at: DispatchTime.now().uptimeNanoseconds)
        }
    }
}
