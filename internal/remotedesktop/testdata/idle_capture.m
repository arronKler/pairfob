#import "../desktop_darwin.h"
static int attempts, encodes;
static CVPixelBufferRef nextImage;
static uint64_t proofRevision, proofAge;
#define VTCompressionSessionEncodeFrame(...) (encodes++, noErr)
#define PFProbeDisplay testProbe
static void testProbe(SCContentFilter *filter, SCStreamConfiguration *cfg, dispatch_queue_t queue,
                      void (^result)(CVPixelBufferRef)) {
    attempts++;
    result(nextImage);
}
#import "../capture_darwin.m"
BOOL PFUnlocked(void) { return YES; }
void PFStop(NSString *reason) { abort(); }
BOOL PFPrepareAudio(void) { return YES; }
void PFAudioFrame(CMSampleBufferRef sample) {}
void PFWrite(uint8_t kind, uint64_t pts, NSData *data) {
    if (kind == 3) {
        proofRevision = pts;
        uint64_t words[2];
        [data getBytes:words length:sizeof(words)];
        proofAge = CFSwapInt64BigToHost(words[1]);
    }
}
static CVPixelBufferRef makeImage(void) {
    CVPixelBufferRef b;
    if (CVPixelBufferCreate(NULL,32,16,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,NULL,&b)) abort();
    CVPixelBufferLockBaseAddress(b,0);
    for (size_t p=0; p<2; p++)
        memset(CVPixelBufferGetBaseAddressOfPlane(b,p),128,CVPixelBufferGetBytesPerRowOfPlane(b,p)*CVPixelBufferGetHeightOfPlane(b,p));
    CVPixelBufferUnlockBaseAddress(b,0);
    return b;
}
int main(void) {
    @autoreleasepool {
        if (@available(macOS 13.0,*)) {
            observationToken = 1;
            lastEncoded = hostNow()-45; // long idle alone must never force encoding
            latest = makeImage();
            revision = 1;
            nextImage = makeImage();
            checkCapture();
            if (attempts!=1 || encodes || proofRevision!=1 || proofAge>100000) return 1;
            // Force changes through the chroma plane towards the end of the last row.
            CVPixelBufferLockBaseAddress(nextImage,0);
            uint8_t *uv=CVPixelBufferGetBaseAddressOfPlane(nextImage,1);
            uv[7*CVPixelBufferGetBytesPerRowOfPlane(nextImage,1)+31]++;
            CVPixelBufferUnlockBaseAddress(nextImage,0);
            lastEvidence = 0; checkCapture();
            if (attempts!=2 || encodes!=1 || proofRevision!=2) return 2;
            CVPixelBufferRelease(nextImage); nextImage=NULL;
            lastEvidence = 0; needsKeyframe=YES; checkCapture();
            if (encodes!=1 || proofAge!=UINT64_MAX || !needsKeyframe) return 3;
            lastEvidence=hostNow(); checkCapture();
            if (encodes!=2 || needsKeyframe) return 4;
            CVPixelBufferRelease(latest);
        }
    }
}
