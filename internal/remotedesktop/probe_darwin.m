#import "desktop_darwin.h"

// Compare active NV12 or BGRA pixels only. Buffer padding and row strides can differ
// between a one-shot capture and the live ScreenCaptureKit stream.
BOOL PFSameCapture(CVPixelBufferRef a, CVPixelBufferRef b) {
    if (!a || !b || CVPixelBufferGetPixelFormatType(a) != CVPixelBufferGetPixelFormatType(b) ||
        CVPixelBufferGetWidth(a) != CVPixelBufferGetWidth(b) || CVPixelBufferGetHeight(a) != CVPixelBufferGetHeight(b))
        return NO;
    OSType format = CVPixelBufferGetPixelFormatType(a);
    BOOL packed = format == kCVPixelFormatType_32BGRA;
    if (!packed && (format != kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ||
                    CVPixelBufferGetPlaneCount(a) != 2 || CVPixelBufferGetPlaneCount(b) != 2)) return NO;
    if (a == b) return YES;
    if (CVPixelBufferLockBaseAddress(a,kCVPixelBufferLock_ReadOnly)) return NO;
    if (CVPixelBufferLockBaseAddress(b,kCVPixelBufferLock_ReadOnly)) {
        CVPixelBufferUnlockBaseAddress(a,kCVPixelBufferLock_ReadOnly);
        return NO;
    }
    BOOL equal = YES;
    for (size_t i = 0; i < (packed ? 1 : 2) && equal; i++) {
        size_t w = packed ? CVPixelBufferGetWidth(a) : CVPixelBufferGetWidthOfPlane(a,i);
        size_t h = packed ? CVPixelBufferGetHeight(a) : CVPixelBufferGetHeightOfPlane(a,i);
        size_t bytes = w * (packed ? 4 : (i == 0 ? 1 : 2));
        size_t strideA = packed ? CVPixelBufferGetBytesPerRow(a) : CVPixelBufferGetBytesPerRowOfPlane(a,i);
        size_t strideB = packed ? CVPixelBufferGetBytesPerRow(b) : CVPixelBufferGetBytesPerRowOfPlane(b,i);
        const uint8_t *pa = packed ? CVPixelBufferGetBaseAddress(a) : CVPixelBufferGetBaseAddressOfPlane(a,i);
        const uint8_t *pb = packed ? CVPixelBufferGetBaseAddress(b) : CVPixelBufferGetBaseAddressOfPlane(b,i);
        equal = pa && pb && bytes <= strideA && bytes <= strideB &&
                (packed || (w == CVPixelBufferGetWidthOfPlane(b,i) && h == CVPixelBufferGetHeightOfPlane(b,i)));
        for (size_t y = 0; equal && y < h; y++)
            equal = memcmp(pa + y*strideA,pb + y*strideB,bytes) == 0;
    }
    CVPixelBufferUnlockBaseAddress(b,kCVPixelBufferLock_ReadOnly);
    CVPixelBufferUnlockBaseAddress(a,kCVPixelBufferLock_ReadOnly);
    return equal;
}

// macOS 13 predates SCScreenshotManager. A short-lived stream supplies one
// newly captured frame for the same authorized display and is then stopped.
API_AVAILABLE(macos(13.0))
@interface PFOneFrame : NSObject<SCStreamOutput> {
    SCStream *stream;
    void (^result)(CVPixelBufferRef);
}
- (void)start:(SCContentFilter *)filter config:(SCStreamConfiguration *)config
        queue:(dispatch_queue_t)queue result:(void (^)(CVPixelBufferRef))handler;
@end
@implementation PFOneFrame
- (void)finish:(CVPixelBufferRef)image {
    if (!result) return;
    void (^callback)(CVPixelBufferRef) = result;
    result = nil;
    callback(image);
    [callback release];
    SCStream *finishing = stream;
    stream = nil;
    [finishing stopCaptureWithCompletionHandler:^(NSError *err){
        [finishing removeStreamOutput:self type:SCStreamOutputTypeScreen error:NULL];
    }];
    [finishing release];
}
- (void)start:(SCContentFilter *)filter config:(SCStreamConfiguration *)config
        queue:(dispatch_queue_t)queue result:(void (^)(CVPixelBufferRef))handler {
    result = [handler copy];
    stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:nil];
    NSError *error = nil;
    if (![stream addStreamOutput:self type:SCStreamOutputTypeScreen sampleHandlerQueue:queue error:&error]) {
        [self finish:NULL];
        return;
    }
    [stream startCaptureWithCompletionHandler:^(NSError *err){
        if (err) dispatch_async(queue,^{[self finish:NULL];});
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),queue,^{[self finish:NULL];});
}
- (void)stream:(SCStream *)s didOutputSampleBuffer:(CMSampleBufferRef)buffer ofType:(SCStreamOutputType)type {
    NSArray *attrs = (NSArray *)CMSampleBufferGetSampleAttachmentsArray(buffer,NO);
    NSNumber *status = [attrs.firstObject objectForKey:SCStreamFrameInfoStatus];
    if (status && (status.integerValue == SCFrameStatusComplete || status.integerValue == SCFrameStatusStarted)) {
        CVPixelBufferRef image = CMSampleBufferGetImageBuffer(buffer);
        if (image) [self finish:image];
    }
}
- (void)dealloc { [stream release]; [result release]; [super dealloc]; }
@end

void PFProbeDisplay(SCContentFilter *filter, SCStreamConfiguration *config, dispatch_queue_t queue,
                    void (^result)(CVPixelBufferRef)) {
    if (@available(macOS 14.0,*)) {
        [SCScreenshotManager captureSampleBufferWithFilter:filter configuration:config completionHandler:^(CMSampleBufferRef sample,NSError *err){
            CVPixelBufferRef image = (sample && !err) ? CMSampleBufferGetImageBuffer(sample) : NULL;
            if (image) CVPixelBufferRetain(image);
            dispatch_async(queue,^{
                result(image);
                if (image) CVPixelBufferRelease(image);
            });
        }];
    } else {
        PFOneFrame *one = [PFOneFrame new];
        [one start:filter config:config queue:queue result:result];
        [one release];
    }
}
