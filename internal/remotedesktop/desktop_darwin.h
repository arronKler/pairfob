#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <VideoToolbox/VideoToolbox.h>

BOOL PFUnlocked(void);
void PFStop(NSString *reason);
void PFInput(NSDictionary *event, CGRect bounds);
void PFReleaseButtons(void);
void PFWrite(uint8_t kind, uint64_t pts, NSData *data);
BOOL PFSameCapture(CVPixelBufferRef a, CVPixelBufferRef b);
void PFProbeDisplay(SCContentFilter *filter, SCStreamConfiguration *config, dispatch_queue_t queue,
                    void (^result)(CVPixelBufferRef)) API_AVAILABLE(macos(13.0));
void PFObserveCapture(uint64_t token) API_AVAILABLE(macos(13.0));
void PFEncoderFeedback(BOOL keyframe, NSInteger bitrate);
void PFStartCapture(SCDisplay *display, NSString *quality, BOOL audio, void (^ready)(NSError *)) API_AVAILABLE(macos(13.0));
BOOL PFPrepareAudio(void);
void PFAudioFrame(CMSampleBufferRef sample);
NSString *PFDisplayUUID(NSScreen *screen);
