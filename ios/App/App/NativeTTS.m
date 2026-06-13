#import <Capacitor/Capacitor.h>

CAP_PLUGIN(NativeTTS, "NativeTTS",
           CAP_PLUGIN_METHOD(downloadTTS, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(getSafeAreaInsets, CAPPluginReturnPromise);
)
