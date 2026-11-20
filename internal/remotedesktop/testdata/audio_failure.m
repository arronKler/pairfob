#import <AudioToolbox/AudioToolbox.h>
// Exercise a terminal converter failure without a capture session or TCC access.
#define AudioConverterFillComplexBuffer(...) ((OSStatus)-1)
#import "../audio_darwin.m"
static int stops;
void PFStop(NSString *reason) { stops++; }
void PFWrite(uint8_t kind,uint64_t pts,NSData *payload) { abort(); }
int main(void) {
    @autoreleasepool {
        float samples[1920] = {0};
        appendPCM(samples,NULL,960);
        if (!stopped || stops != 1 || pendingFrames != 0) return 1;
        appendPCM(samples,NULL,960);
        PFAudioFrame(NULL);
        return stops != 1 || pendingFrames != 0;
    }
}
