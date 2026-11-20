import CoreMedia
import Foundation
import VideoToolbox

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func check(_ status: OSStatus, _ operation: String) {
    if status != noErr { fail("\(operation) failed (\(status))") }
}

// One length-prefixed Annex B access unit per sample, with capture PTS in microseconds.
private func writeSample(_ sample: CMSampleBuffer, flip: CapturedFlip?) {
    let encodedAt = DispatchTime.now().uptimeNanoseconds
    guard let format = sample.formatDescription, let block = sample.dataBuffer else { return }
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]]
    let key = attachments?.first?[kCMSampleAttachmentKey_NotSync as String] as? Bool != true
    let start: [UInt8] = [0, 0, 0, 1]
    var output = Data()
    var prefix: Int32 = 0
    var count = 0
    check(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0,
        parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count,
        nalUnitHeaderLengthOut: &prefix), "parameter count")
    guard prefix == 4 else { fail("Unsupported NAL length") }
    if key {
        for i in 0..<count {
            var ptr: UnsafePointer<UInt8>?
            var size = 0
            check(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i,
                parameterSetPointerOut: &ptr, parameterSetSizeOut: &size, parameterSetCountOut: nil,
                nalUnitHeaderLengthOut: nil), "parameter set")
            guard let ptr else { fail("Missing H.264 parameter set") }
            output.append(contentsOf: start)
            output.append(ptr, count: size)
        }
    }
    var offset = 0
    let length = CMBlockBufferGetDataLength(block)
    while offset < length {
        var size: UInt32 = 0
        check(CMBlockBufferCopyDataBytes(block, atOffset: offset, dataLength: 4, destination: &size), "NAL length")
        offset += 4
        let n = Int(UInt32(bigEndian: size))
        guard n > 0, n <= length - offset else { fail("Invalid H.264 sample") }
        output.append(contentsOf: start)
        let index = output.count
        output.count += n
        output.withUnsafeMutableBytes { bytes in
            check(CMBlockBufferCopyDataBytes(block, atOffset: offset, dataLength: n,
                destination: bytes.baseAddress! + index), "NAL data")
        }
        offset += n
    }
    var size = UInt32(output.count).bigEndian
    var pts = UInt64(sample.presentationTimeStamp.seconds * 1_000_000).bigEndian
    var record = Data(bytes: &size, count: 4)
    record.append(Data(bytes: &pts, count: 8))
    var id = (flip?.input.id ?? 0).bigEndian
    record.append(Data(bytes: &id, count: 4))
    if let flip {
        let times = [flip.input.readAt, flip.input.drawAt, flip.capturedAt, encodedAt]
        for (start, end) in zip(times, times.dropFirst()) {
            var micros = UInt32(clamping: (end - start) / 1000).bigEndian
            record.append(Data(bytes: &micros, count: 4))
        }
    }
    record.append(output)
    FileHandle.standardOutput.write(record)
}

final class Encoder {
    private let session: VTCompressionSession

    init(width: Int, height: Int, fps: Int) {
        var created: VTCompressionSession?
        let spec = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
                    kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary
        check(VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264, encoderSpecification: spec,
            imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: { _, token, status, _, sample in
                let flip = token.map { Unmanaged<CapturedFlip>.fromOpaque($0).takeRetainedValue() }
                check(status, "encode callback")
                if let sample { writeSample(sample, flip: flip) }
            }, refcon: nil, compressionSessionOut: &created), "hardware encoder")
        guard let created else { fail("No hardware session") }
        session = created
        let properties: [CFString: Any] = [
            kVTCompressionPropertyKey_RealTime: true,
            kVTCompressionPropertyKey_AllowFrameReordering: false,
            kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_Baseline_AutoLevel,
            kVTCompressionPropertyKey_MaxKeyFrameInterval: fps,
            kVTCompressionPropertyKey_ExpectedFrameRate: fps,
            kVTCompressionPropertyKey_AverageBitRate: 8_000_000,
        ]
        check(VTSessionSetProperties(session, propertyDictionary: properties as CFDictionary), "encoder configuration")
        let speedHint = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
            value: kCFBooleanTrue)
        if speedHint != noErr {
            FileHandle.standardError.write(Data("Encoder speed preference unavailable (\(speedHint)); using default\n".utf8))
        }
        check(VTCompressionSessionPrepareToEncodeFrames(session), "prepare")
    }

    func encode(_ image: CVPixelBuffer, pts: CMTime, flip: CapturedFlip?) {
        check(VTCompressionSessionEncodeFrame(session, imageBuffer: image, presentationTimeStamp: pts,
            duration: .invalid, frameProperties: nil, sourceFrameRefcon: flip.map { Unmanaged.passRetained($0).toOpaque() }, infoFlagsOut: nil), "encode")
    }
}
