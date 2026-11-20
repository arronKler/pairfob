#import "desktop_darwin.h"
#import <AudioToolbox/AudioToolbox.h>

static VTCompressionSessionRef encoder;
static SCStream *stream API_AVAILABLE(macos(13.0));
static dispatch_queue_t frames;
static CVPixelBufferRef latest;
static double lastEncoded;
static dispatch_source_t refresh;
static SCContentFilter *selectedFilter API_AVAILABLE(macos(13.0));
static SCStreamConfiguration *probeConfig API_AVAILABLE(macos(13.0));
// Accessed only on the serial frames queue. Encoder callbacks receive their
// own revision through sourceFrameRefCon and never read mutable capture state.
static uint64_t revision, observationToken;
static double lastEvidence;
static BOOL probing, needsKeyframe;

static double hostNow(void) { return CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())); }

static void reportEvidence(uint64_t token) {
    if (!observationToken || !revision) return;
    double age = hostNow()-lastEvidence;
    uint64_t payload[] = {CFSwapInt64HostToBig(token),
        CFSwapInt64HostToBig(lastEvidence > 0 && age >= 0 && age < 2.5 ? (uint64_t)(age*1e6) : UINT64_MAX)};
    PFWrite(3,revision,[NSData dataWithBytes:payload length:sizeof(payload)]);
}

static void encoded(void *ctx, void *source, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
    @autoreleasepool {
        if (status) { PFStop(@"H.264 encoder interrupted"); return; }
        if (!sample) return;
        CMFormatDescriptionRef fmt = CMSampleBufferGetFormatDescription(sample);
        CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
        if (!block) return;
        double submitted = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample));
        double duration = fmax(0.0,hostNow()-submitted);
        uint64_t metadata[] = {CFSwapInt64HostToBig((uintptr_t)source),CFSwapInt64HostToBig((uint64_t)(duration*1e6))};
        NSMutableData *out = [NSMutableData dataWithBytes:metadata length:sizeof(metadata)];
        uint8_t start[] = {0,0,0,1};
        CFArrayRef att = CMSampleBufferGetSampleAttachmentsArray(sample, false);
        BOOL key = !att || !CFDictionaryContainsKey(CFArrayGetValueAtIndex(att,0), kCMSampleAttachmentKey_NotSync);
        if (key) {
            size_t count = 0;
            if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt,0,NULL,NULL,&count,NULL)) return;
            for (size_t i = 0; i < count; i++) {
                const uint8_t *ptr; size_t size;
                if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt,i,&ptr,&size,NULL,NULL)) return;
                [out appendBytes:start length:4]; [out appendBytes:ptr length:size];
            }
        }
        size_t len = CMBlockBufferGetDataLength(block);
        for (size_t off = 0; off < len;) {
            uint32_t n;
            if (len-off < 4 || CMBlockBufferCopyDataBytes(block,off,4,&n)) return;
            n = ntohl(n); off += 4;
            if (!n || n > len-off) return;
            [out appendBytes:start length:4];
            size_t dest = out.length;
            [out increaseLengthBy:n];
            if (CMBlockBufferCopyDataBytes(block,off,n,(uint8_t *)out.mutableBytes+dest)) return;
            off += n;
        }
        PFWrite(4,(uint64_t)(submitted*1e6),out);
    }
}

static void encode(BOOL force) {
    if (!latest) return;
    CMTime pts = CMClockGetTime(CMClockGetHostTimeClock());
    lastEncoded = CMTimeGetSeconds(pts);
    NSDictionary *opts = force ? @{(id)kVTEncodeFrameOptionKey_ForceKeyFrame:@YES} : nil;
    if (VTCompressionSessionEncodeFrame(encoder,latest,pts,kCMTimeInvalid,(CFDictionaryRef)opts,(void *)(uintptr_t)revision,NULL))
        PFStop(@"Unable to encode display");
}

static void acceptImage(CVPixelBufferRef image, double evidence) {
    CVPixelBufferRetain(image);
    if (latest) CVPixelBufferRelease(latest);
    latest = image;
    revision++;
    lastEvidence = evidence;
    reportEvidence(0);
    encode(needsKeyframe);
    needsKeyframe = NO;
}

// Request a new, independent capture when the primary stream is silent.
// Never turn an old cached buffer or a process timer into a freshness proof.
API_AVAILABLE(macos(13.0))
static void checkCapture(void) {
    double now = hostNow();
    if (lastEvidence > 0 && now >= lastEvidence && now-lastEvidence < 0.65) {
        reportEvidence(observationToken);
        if (needsKeyframe) { encode(YES); needsKeyframe = NO; }
        return;
    }
    if (probing) return;
    if (!PFUnlocked()) { PFStop(@"Mac is locked"); return; }
    probing = YES;
    uint64_t before = revision;
    PFProbeDisplay(selectedFilter,probeConfig,frames,^(CVPixelBufferRef image){
        probing = NO;
        if (!PFUnlocked()) { PFStop(@"Mac is locked"); return; }
        // A primary frame may have superseded this shot. Bound the lifetime
        // of the asynchronous shot using its start time on the same clock.
        if (revision == before && image && hostNow()-now < 1.5) {
            if (!PFSameCapture(latest,image)) acceptImage(image,now);
            else lastEvidence = fmax(lastEvidence,now);
        }
        reportEvidence(observationToken);
        if (needsKeyframe && lastEvidence > 0 && hostNow()-lastEvidence < 1.5 && latest) { encode(YES); needsKeyframe = NO; }
    });
}

void PFObserveCapture(uint64_t token) {
    if (!token) return;
    dispatch_async(frames, ^{
        observationToken = token;
        checkCapture();
    });
}

void PFEncoderFeedback(BOOL keyframe, NSInteger bitrate) {
    dispatch_async(frames, ^{
        if (bitrate >= 500000 && bitrate <= 12000000)
            VTSessionSetProperty(encoder,kVTCompressionPropertyKey_AverageBitRate,(CFNumberRef)@(bitrate));
        if (keyframe) {
            needsKeyframe = YES;
            if (observationToken) {
                if (@available(macOS 13.0,*)) checkCapture();
            } else if (latest) {
                encode(YES); needsKeyframe = NO;
            }
        }
    });
}

API_AVAILABLE(macos(13.0))
@interface PFFrames : NSObject<SCStreamOutput,SCStreamDelegate>
@end
@implementation PFFrames
- (void)stream:(SCStream *)s didStopWithError:(NSError *)error { PFStop(error.localizedDescription); }
- (void)stream:(SCStream *)s didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if (!CMSampleBufferIsValid(sample)) return;
    if (type == SCStreamOutputTypeAudio) { PFAudioFrame(sample); return; }
    NSArray *att = (NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample,NO);
    NSNumber *status = [att.firstObject objectForKey:SCStreamFrameInfoStatus];
    if (!status) return;
    NSNumber *displayTime = [att.firstObject objectForKey:SCStreamFrameInfoDisplayTime];
    double evidence = displayTime ? CMTimeGetSeconds(CMClockMakeHostTimeFromSystemUnits(displayTime.unsignedLongLongValue)) : 0;
    if (status.integerValue == SCFrameStatusIdle) {
        if (latest) lastEvidence = fmax(lastEvidence,evidence);
        return;
    }
    if (status.integerValue != SCFrameStatusComplete && status.integerValue != SCFrameStatusStarted) {
        PFStop(@"Display is no longer active"); return;
    }
    CVPixelBufferRef image = CMSampleBufferGetImageBuffer(sample);
    if (!image) return;
    acceptImage(image,evidence);
}
@end

void PFStartCapture(SCDisplay *d, NSString *quality, BOOL audio, void (^ready)(NSError *)) {
    BOOL detail = [quality isEqual:@"detail"], motion = [quality isEqual:@"motion"];
    int maxEdge = detail ? 2560 : motion ? 1280 : 1920, fps = detail ? 30 : 60;
    size_t w = CGDisplayPixelsWide(d.displayID), h = CGDisplayPixelsHigh(d.displayID);
    double scale = fmin(1.0, (double)maxEdge/MAX(w,h));
    SCStreamConfiguration *cfg = [SCStreamConfiguration new];
    cfg.width = MAX(2, (int)(w*scale)/2*2); cfg.height = MAX(2, (int)(h*scale)/2*2);
    cfg.minimumFrameInterval = CMTimeMake(1,fps); cfg.queueDepth = 3; cfg.showsCursor = YES;
    cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
    if (audio && !PFPrepareAudio()) { PFStop(@"System audio encoder unavailable"); return; }
    cfg.capturesAudio = audio; cfg.sampleRate = 48000; cfg.channelCount = 2;
    NSDictionary *spec = @{(id)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder:@YES};
    OSStatus status = VTCompressionSessionCreate(NULL,(int)cfg.width,(int)cfg.height,kCMVideoCodecType_H264,
        (CFDictionaryRef)spec,NULL,NULL,encoded,NULL,&encoder);
    NSDictionary *props = @{(id)kVTCompressionPropertyKey_RealTime:@YES,(id)kVTCompressionPropertyKey_AllowFrameReordering:@NO,
        (id)kVTCompressionPropertyKey_ProfileLevel:(id)kVTProfileLevel_H264_Baseline_AutoLevel,
        (id)kVTCompressionPropertyKey_AverageBitRate:@(detail ? 12000000 : motion ? 4500000 : 8000000),
        (id)kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration:@1,(id)kVTCompressionPropertyKey_MaxKeyFrameInterval:@(fps)};
    if (status || VTSessionSetProperties(encoder,(CFDictionaryRef)props) || VTCompressionSessionPrepareToEncodeFrames(encoder)) {
        PFStop(@"Hardware H.264 encoder unavailable"); return;
    }
    PFFrames *sink = [PFFrames new];
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:d excludingWindows:@[]];
    selectedFilter = filter;
    probeConfig = [SCStreamConfiguration new];
    probeConfig.width = cfg.width; probeConfig.height = cfg.height;
    probeConfig.pixelFormat = cfg.pixelFormat; probeConfig.showsCursor = cfg.showsCursor;
    stream = [[SCStream alloc] initWithFilter:filter configuration:cfg delegate:sink];
    frames = dispatch_queue_create("pairfob.desktop.frames",DISPATCH_QUEUE_SERIAL);
    NSError *error = nil;
    if (![stream addStreamOutput:sink type:SCStreamOutputTypeScreen sampleHandlerQueue:frames error:&error] ||
        (audio && ![stream addStreamOutput:sink type:SCStreamOutputTypeAudio sampleHandlerQueue:frames error:&error])) {
        PFStop(error.localizedDescription); return;
    }
    [stream startCaptureWithCompletionHandler:^(NSError *err) {
        ready(err);
        refresh = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,frames);
        dispatch_source_set_timer(refresh,dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/2),NSEC_PER_SEC/2,0);
        dispatch_source_set_event_handler(refresh,^{
            if (!observationToken && hostNow()-lastEncoded >= 0.45) encode(YES);
        });
        dispatch_resume(refresh);
    }];
}
