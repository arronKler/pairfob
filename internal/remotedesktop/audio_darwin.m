#import "desktop_darwin.h"
#import <AudioToolbox/AudioToolbox.h>

// ScreenCaptureKit delivers float PCM in variable-sized, potentially planar buffers.
// The Opus encoder consumes interleaved stereo at a fixed 20 ms packet duration.
static AudioConverterRef converter;
static float pendingPCM[960 * 2];
static UInt32 pendingFrames;
// All audio callbacks run on the serial capture queue.
static BOOL stopped;
static void stopAudio(NSString *reason) {
    if (stopped) return;
    stopped = YES;
    pendingFrames = 0;
    PFStop(reason);
}

static const OSStatus needInput = 'pfin';

BOOL PFPrepareAudio(void) {
    AudioStreamBasicDescription pcm = {
        .mSampleRate = 48000, .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        .mBytesPerPacket = 8, .mFramesPerPacket = 1, .mBytesPerFrame = 8,
        .mChannelsPerFrame = 2, .mBitsPerChannel = 32
    };
    AudioStreamBasicDescription opus = {
        .mSampleRate = 48000, .mFormatID = kAudioFormatOpus, .mFramesPerPacket = 960, .mChannelsPerFrame = 2
    };
    if (AudioConverterNew(&pcm, &opus, &converter) != noErr) return NO;
    UInt32 bitrate = 96000;
    AudioConverterSetProperty(converter, kAudioConverterEncodeBitRate, sizeof(bitrate), &bitrate);
    return YES;
}

static OSStatus supplyPCM(AudioConverterRef c, UInt32 *packets, AudioBufferList *list,
                          AudioStreamPacketDescription **descriptions, void *context) {
    UInt32 *offset = context;
    UInt32 n = MIN(*packets, pendingFrames - *offset);
    *packets = n;
    if (!n) return needInput;
    list->mNumberBuffers = 1;
    list->mBuffers[0] = (AudioBuffer){ .mNumberChannels = 2, .mDataByteSize = n * 8, .mData = pendingPCM + *offset * 2 };
    *offset += n;
    return noErr;
}

static BOOL encodePacket(void) {
    UInt32 offset = 0, packets = 1;
    UInt8 payload[4096];
    AudioBufferList output = { .mNumberBuffers = 1, .mBuffers = {{2,sizeof(payload),payload}} };
    AudioStreamPacketDescription description = {0};
    OSStatus status = AudioConverterFillComplexBuffer(converter, supplyPCM, &offset, &packets, &output, &description);
    if (status != noErr && status != needInput) return NO;
    if (packets && output.mBuffers[0].mDataByteSize)
        PFWrite(2,0,[NSData dataWithBytes:payload length:output.mBuffers[0].mDataByteSize]);
    if (!offset) return NO;
    pendingFrames -= offset;
    if (pendingFrames) memmove(pendingPCM,pendingPCM + 2 * offset,pendingFrames * 8);
    return YES;
}

static void appendPCM(const float *left,const float *right,size_t frames) {
    if (stopped) return;
    for (size_t i = 0; i < frames; i++) {
        if (pendingFrames >= 960) { stopAudio(@"System audio buffer full"); return; }
        pendingPCM[2*pendingFrames] = right ? left[i] : left[2*i];
        pendingPCM[2*pendingFrames+1] = right ? right[i] : left[2*i+1];
        if (++pendingFrames == 960 && !encodePacket()) {
            stopAudio(@"System audio encoder interrupted"); return;
        }
    }
}

void PFAudioFrame(CMSampleBufferRef sample) {
    if (stopped) return;
    const AudioStreamBasicDescription *format = CMAudioFormatDescriptionGetStreamBasicDescription(CMSampleBufferGetFormatDescription(sample));
    if (!format || format->mSampleRate != 48000 || format->mChannelsPerFrame != 2 ||
        format->mFormatID != kAudioFormatLinearPCM || format->mBitsPerChannel != 32 ||
        !(format->mFormatFlags & kAudioFormatFlagIsFloat)) { stopAudio(@"Unsupported system audio format"); return; }
    struct { UInt32 count; AudioBuffer buffers[2]; } storage;
    AudioBufferList *list = (AudioBufferList *)&storage;
    CMBlockBufferRef block = NULL;
    if (CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample,NULL,list,sizeof(storage),NULL,NULL,0,&block)) return;
    BOOL planar = list->mNumberBuffers == 2;
    if ((!planar && (list->mNumberBuffers != 1 || list->mBuffers[0].mNumberChannels != 2)) ||
        (planar && (list->mBuffers[0].mNumberChannels != 1 || list->mBuffers[1].mNumberChannels != 1))) {
        if (block) CFRelease(block);
        stopAudio(@"Unexpected stereo buffer layout"); return;
    }
    const float *left = list->mBuffers[0].mData;
    const float *right = planar ? list->mBuffers[1].mData : NULL;
    size_t frames = planar ? MIN(list->mBuffers[0].mDataByteSize,list->mBuffers[1].mDataByteSize)/4 : list->mBuffers[0].mDataByteSize/8;
    appendPCM(left,right,frames);
    if (block) CFRelease(block);
}
