import UIKit
import Capacitor
import AVFoundation
import MediaPlayer
import CallKit

// Unified App Logger for deep tracing
func writeAppLog(_ tag: String, _ message: String) {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss.SSS"
    let timeStr = formatter.string(from: Date())
    let line = "[\(timeStr)] [\(tag)] \(message)\n"
    print(line, terminator: "")
    if let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
        let logFile = docs.appendingPathComponent("debug_execution.log")
        if let data = line.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: logFile.path) {
                if let handle = try? FileHandle(forWritingTo: logFile) {
                    handle.seekToEndOfFile()
                    handle.write(data)
                    try? handle.close()
                }
            } else {
                try? data.write(to: logFile)
            }
        }
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Configure audio session for background TTS playback (.allowAirPlay, .allowBluetooth, .allowBluetoothA2DP)
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .default, options: [.allowAirPlay, .allowBluetooth, .allowBluetoothA2DP])
            try audioSession.setActive(true)
        } catch {
            print("[NativeTTS] Failed to configure AVAudioSession at launch: \(error)")
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
    }

    func applicationWillTerminate(_ application: UIApplication) {
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        if url.scheme == "edgereader", url.host == "eval" {
            if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
               let queryItem = components.queryItems?.first(where: { $0.name == "cmd" }),
               let cmd = queryItem.value {
                DispatchQueue.main.async {
                    let rootVC = self.window?.rootViewController ?? app.windows.first?.rootViewController
                    if let bridgeVC = rootVC as? CAPBridgeViewController {
                        bridgeVC.bridge?.webView?.evaluateJavaScript(cmd, completionHandler: nil)
                    }
                }
            }
            return true
        }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

class ViewController: CAPBridgeViewController {
    var currentStatusBarStyle: UIStatusBarStyle = .default
    private var cmdTimer: Timer?

    override var canBecomeFirstResponder: Bool {
        return true
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return currentStatusBarStyle
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        return config
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(NativeTTS())

        cmdTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let cmdFile = docs.appendingPathComponent("cmd.js")
            if FileManager.default.fileExists(atPath: cmdFile.path) {
                if let code = try? String(contentsOf: cmdFile, encoding: .utf8) {
                    try? FileManager.default.removeItem(at: cmdFile)
                    self.webView?.evaluateJavaScript(code) { res, err in
                        let statusFile = docs.appendingPathComponent("cmd_status.json")
                        let success = (err == nil)
                        let status: [String: Any] = [
                            "success": success,
                            "error": err?.localizedDescription ?? "",
                            "result": "\(res ?? "")"
                        ]
                        if let data = try? JSONSerialization.data(withJSONObject: status) {
                            try? data.write(to: statusFile)
                        }
                    }
                }
            }
        }
    }
}

@objc(NativeTTS)
public class NativeTTS: CAPPlugin, CAPBridgedPlugin, AVAudioPlayerDelegate, CXCallObserverDelegate {
    public let identifier = "NativeTTS"
    public let jsName = "NativeTTS"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "downloadTTS", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelTTS", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelAllTTS", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteTTSFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanupTTSFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncClock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSafeAreaInsets", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setStatusBarStyle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startForegroundService", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updatePlaybackState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopForegroundService", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createZipFromDirectory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveFileToSystem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyFileToDownloads", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPlaybackSyncState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "simulateRemoteCommand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeLog", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playNativeSentence", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareNextSentence", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseNative", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeNative", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopNative", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRateNative", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolumeNative", returnType: CAPPluginReturnPromise)
    ]

    public static weak var shared: NativeTTS?
    public var lastMPRemoteCommandTime: TimeInterval = 0

    private var lastRemoteCommandTime: TimeInterval = 0
    private var lastRemoteCommandType: String = ""
    private var lastRemotePauseTime: TimeInterval = 0
    private func shouldThrottleRemoteCommand(type: String = "") -> Bool {
        let now = Date().timeIntervalSince1970
        if now - lastRemoteCommandTime < 0.35 {
            writeAppLog("NativeTTS", "Throttling duplicated remote command '\(type)' (<\(String(format: "%.3f", now - lastRemoteCommandTime))s since '\(lastRemoteCommandType)')")
            return true
        }
        lastRemoteCommandTime = now
        lastRemoteCommandType = type
        return false
    }

    @objc func writeLog(_ call: CAPPluginCall) {
        let tag = call.getString("tag") ?? "JS"
        let msg = call.getString("message") ?? ""
        writeAppLog(tag, msg)
        call.resolve()
    }

    // MARK: - Route B: Native Audio Engine (Twin-Player AVAudioPlayer)
    private var playerA: AVAudioPlayer?
    private var playerB: AVAudioPlayer?
    private var activePlayerTag: Int = 0 // 0 = playerA, 1 = playerB
    private var preparedPlayerTag: Int = 1
    private var currentPlayingSentenceIndex: Int = -1
    private var preparedSentenceIndex: Int = -1
    private var currentPlaybackRate: Float = 1.0
    private var currentPlaybackVolume: Float = 1.0
    private var isNativeEngineActive: Bool = false
    private var activePlayerFilePath: String = ""
    private var preparedPlayerFilePath: String = ""
    private var currentChapterTotalDuration: Double = 60.0
    private var currentChapterProgressBase: Double = 0.0
    private var currentChapterTitle: String = ""
    private var currentChapterArtist: String = ""
    private var currentSentenceText: String = ""

    private var activePlayer: AVAudioPlayer? {
        get { return activePlayerTag == 0 ? playerA : playerB }
        set {
            if activePlayerTag == 0 {
                playerA = newValue
            } else {
                playerB = newValue
            }
        }
    }

    private var preparedPlayer: AVAudioPlayer? {
        get { return preparedPlayerTag == 0 ? playerA : playerB }
        set {
            if preparedPlayerTag == 0 {
                playerA = newValue
            } else {
                playerB = newValue
            }
        }
    }

    private var activeTasks = [String: URLSessionWebSocketTask]()
    private var timeoutWorkItems = [String: DispatchWorkItem]()
    private let taskLock = NSLock()
    private var currentArtwork: MPMediaItemArtwork?
    private var wasPlayingBeforeInterruption: Bool = false
    private var wasPlayingBeforeCall: Bool = false
    private var hasActiveCall: Bool = false
    private var callObserver: CXCallObserver?
    private var pendingResumeWorkItem: DispatchWorkItem?
    private var callInterruptionBgTaskId: UIBackgroundTaskIdentifier = .invalid
    private var callInterruptionTimer: Timer?
    private var interruptionResumeBgTaskId: UIBackgroundTaskIdentifier = .invalid
    private var interruptionResumeTimer: Timer?
    private var isAudioSessionInterrupted: Bool = false
    private var isCurrentlyPlaying: Bool = false
    private var authoritativeNowPlayingInfo: [String: Any] = [:]
    private var silencePlayer: AVAudioPlayer?
    private var silencePauseTimer: Timer?
    private var nowPlayingGuardianTimer: Timer?
    private lazy var ttsSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10.0
        config.timeoutIntervalForResource = 15.0
        config.httpMaximumConnectionsPerHost = 10
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    public override init() {
        super.init()
    }

    // MARK: - Native Silence Keep-Alive Player
    // Generates a 2-second 44.1kHz 16-bit mono silence PCM WAV buffer with sub-audible 1-LSB dither (-90.3 dBFS)
    private func createSilentAudioData() -> Data {
        let sampleRate: Int32 = 44100
        let numChannels: Int16 = 1
        let bitsPerSample: Int16 = 16
        let numSamples: Int32 = sampleRate * 2
        let dataSize: Int32 = numSamples * Int32(numChannels) * Int32(bitsPerSample / 8)
        let chunkSize: Int32 = 36 + dataSize
        
        var data = Data()
        data.append(contentsOf: [0x52, 0x49, 0x46, 0x46]) // "RIFF"
        var chunkSizeBytes = chunkSize.littleEndian
        data.append(Data(bytes: &chunkSizeBytes, count: 4))
        data.append(contentsOf: [0x57, 0x41, 0x56, 0x45]) // "WAVE"
        data.append(contentsOf: [0x66, 0x6d, 0x74, 0x20]) // "fmt "
        var subchunk1Size: Int32 = Int32(16).littleEndian
        data.append(Data(bytes: &subchunk1Size, count: 4))
        var audioFormat: Int16 = Int16(1).littleEndian // PCM
        data.append(Data(bytes: &audioFormat, count: 2))
        var channels = numChannels.littleEndian
        data.append(Data(bytes: &channels, count: 2))
        var sRate = sampleRate.littleEndian
        data.append(Data(bytes: &sRate, count: 4))
        var byteRate: Int32 = (sampleRate * Int32(numChannels) * Int32(bitsPerSample / 8)).littleEndian
        data.append(Data(bytes: &byteRate, count: 4))
        var blockAlign: Int16 = (numChannels * (bitsPerSample / 8)).littleEndian
        data.append(Data(bytes: &blockAlign, count: 2))
        var bps = bitsPerSample.littleEndian
        data.append(Data(bytes: &bps, count: 2))
        data.append(contentsOf: [0x64, 0x61, 0x74, 0x61]) // "data"
        var dSize = dataSize.littleEndian
        data.append(Data(bytes: &dSize, count: 4))
        
        var pcmData = Data(capacity: Int(dataSize))
        var samplePos: Int16 = Int16(1).littleEndian
        var sampleNeg: Int16 = Int16(-1).littleEndian
        for i in 0..<numSamples {
            if i % 2 == 0 {
                pcmData.append(Data(bytes: &samplePos, count: 2))
            } else {
                pcmData.append(Data(bytes: &sampleNeg, count: 2))
            }
        }
        data.append(pcmData)
        return data
    }

    private func ensureSilencePlayer() {
        if silencePlayer == nil {
            let silentData = createSilentAudioData()
            do {
                silencePlayer = try AVAudioPlayer(data: silentData)
                silencePlayer?.numberOfLoops = -1
                silencePlayer?.volume = 0.001
                silencePlayer?.prepareToPlay()
            } catch {
                print("[NativeTTS] Failed to initialize silencePlayer: \(error)")
            }
        }
    }

    func startSilencePlayer() {
        if self.isNativeEngineActive {
            return
        }
        self.activateAudioSession()
        cancelSilencePauseTimer()
        ensureSilencePlayer()
        if silencePlayer?.isPlaying == false {
            silencePlayer?.play()
            writeAppLog("NativeTTS", "Silence keep-alive player running (keeps WebKit process alive)")
        }
    }

    func stopSilencePlayer() {
        cancelSilencePauseTimer()
        silencePlayer?.stop()
        silencePlayer = nil
        writeAppLog("NativeTTS", "Silence keep-alive player stopped")
    }

    func scheduleSilencePauseTimer() {
        cancelSilencePauseTimer()
        if self.isNativeEngineActive {
            // Route B uses native AVAudioPlayer directly.
            // Playing silence during pause in Route B causes iOS CoreAudio to detect active audio output,
            // which forces the lock screen / Control Center to show ⏸ (playing) instead of ▶ (paused).
            stopSilencePlayer()
            return
        }
        startSilencePlayer()
        DispatchQueue.main.async { [weak self] in
            // Keep silence player alive for 30 minutes after pause, preventing iOS from freezing WKWebView
            self?.silencePauseTimer = Timer.scheduledTimer(withTimeInterval: 30 * 60, repeats: false) { [weak self] _ in
                guard let self = self else { return }
                if !self.isCurrentlyPlaying {
                    print("[NativeTTS] 30min pause timeout reached, stopping silence player to conserve battery")
                    self.stopSilencePlayer()
                    DispatchQueue.global(qos: .userInitiated).async {
                        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                    }
                }
            }
        }
    }

    func cancelSilencePauseTimer() {
        DispatchQueue.main.async { [weak self] in
            self?.silencePauseTimer?.invalidate()
            self?.silencePauseTimer = nil
        }
    }

    // MARK: - Remote Commands State Sync
    // Keep both play and pause commands ALWAYS enabled for maximum Bluetooth headphone compatibility.
    // Some BT headphones (AVRCP 1.3, older/budget models) send only playCommand or only pauseCommand
    // rather than togglePlayPauseCommand. If the command is disabled, iOS silently drops the event.
    // The correct playing/paused button on lock screen is driven by MPNowPlayingInfoCenter.playbackState
    // and MPNowPlayingInfoPropertyPlaybackRate, NOT by command isEnabled state.
    func updateRemoteCommandsState(isPlaying: Bool) {
        DispatchQueue.main.async {
            let commandCenter = MPRemoteCommandCenter.shared()
            commandCenter.playCommand.isEnabled = true
            commandCenter.pauseCommand.isEnabled = true
            commandCenter.togglePlayPauseCommand.isEnabled = true
        }
    }

    // MARK: - Authoritative Unified NowPlaying State Sync
    func syncNowPlaying(isPlaying: Bool) {
        self.isCurrentlyPlaying = isPlaying
        self.updateRemoteCommandsState(isPlaying: isPlaying)

        self.authoritativeNowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        self.authoritativeNowPlayingInfo[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0
        if let artwork = self.currentArtwork {
            self.authoritativeNowPlayingInfo[MPMediaItemPropertyArtwork] = artwork
        }

        let info = self.authoritativeNowPlayingInfo
        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
            }
        }
    }

    // MARK: - NowPlaying State Guardian
    // Prevents WebKit's asynchronous audio pause IPC from knocking iOS lock screen/notification center into paused state
    func startNowPlayingGuardian() {
        guard self.isCurrentlyPlaying else { return }
        stopNowPlayingGuardian()
        self.updateRemoteCommandsState(isPlaying: true)
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.isCurrentlyPlaying else { return }
            // Run at 0.5s intervals for lock screen state recovery without spamming CoreAudio metadata
            let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                guard self.isCurrentlyPlaying else {
                    self.stopNowPlayingGuardian()
                    return
                }

                if #available(iOS 13.0, *) {
                    if MPNowPlayingInfoCenter.default().playbackState != .playing {
                        MPNowPlayingInfoCenter.default().playbackState = .playing
                    }
                }
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    let currentRate = info[MPNowPlayingInfoPropertyPlaybackRate] as? Double ?? 0.0
                    if currentRate < 0.5 {
                        info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
                        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                    }
                } else if !self.authoritativeNowPlayingInfo.isEmpty {
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = self.authoritativeNowPlayingInfo
                }
            }
            RunLoop.main.add(timer, forMode: .common)
            self.nowPlayingGuardianTimer = timer
        }
    }

    func stopNowPlayingGuardian() {
        if Thread.isMainThread {
            self.nowPlayingGuardianTimer?.invalidate()
            self.nowPlayingGuardianTimer = nil
        } else {
            DispatchQueue.main.sync { [weak self] in
                self?.nowPlayingGuardianTimer?.invalidate()
                self?.nowPlayingGuardianTimer = nil
            }
        }
    }

    // MARK: - Emergency Pause & Resume
    func emergencyPause(reason: String) {
        writeAppLog("NativeTTS", "Emergency pause triggered: \(reason)")
        self.pendingResumeWorkItem?.cancel()
        self.pendingResumeWorkItem = nil
        self.lastRemotePauseTime = Date().timeIntervalSince1970
        self.isCurrentlyPlaying = false
        self.stopNowPlayingGuardian()

        if self.isNativeEngineActive {
            self.activePlayer?.pause()
            self.preparedPlayer?.pause()
        }

        // Immediately pause silence player to prevent any audio hardware output
        self.silencePlayer?.pause()
        self.syncNowPlaying(isPlaying: false)

        let updateWebViewBlock = { [weak self] in
            guard let self = self else { return }
            // Force emergency pause on WKWebView AudioElements and window.tts, setting _pauseFromNative and _isInterrupted
            self.bridge?.webView?.evaluateJavaScript(
                "if (window.tts) { window.tts._pauseFromNative = true; window.tts._isInterrupted = true; window.tts.pause(); window.tts._pauseFromNative = false; } else { document.querySelectorAll('audio').forEach(function(a) { a.pause(); }); }",
                completionHandler: nil
            )
            // Notify listeners
            self.notifyListeners("mediaAction", data: ["action": "pause"])
        }

        if Thread.isMainThread {
            updateWebViewBlock()
        } else {
            DispatchQueue.main.async {
                updateWebViewBlock()
            }
        }
    }

    @discardableResult
    func activateAudioSession() -> Bool {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.allowAirPlay, .allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true)
            return true
        } catch {
            writeAppLog("NativeTTS", "Failed to activate AVAudioSession: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Interruption Background Task Management
    private func beginCallInterruptionBgTask() {
        endCallInterruptionBgTask()
        callInterruptionBgTaskId = UIApplication.shared.beginBackgroundTask(withName: "CallInterruptionGracePeriod") { [weak self] in
            writeAppLog("NativeTTS", "CallInterruptionGracePeriod background task expired by iOS")
            self?.endCallInterruptionBgTask()
        }
        writeAppLog("NativeTTS", "beginCallInterruptionBgTask: id=\(callInterruptionBgTaskId.rawValue)")
        DispatchQueue.main.async { [weak self] in
            self?.callInterruptionTimer?.invalidate()
            // iOS allows up to 30s background execution time. Set timer for 28s to cleanly release before hard kill.
            self?.callInterruptionTimer = Timer.scheduledTimer(withTimeInterval: 28.0, repeats: false) { [weak self] _ in
                writeAppLog("NativeTTS", "CallInterruptionGracePeriod background task 28s timer reached")
                self?.endCallInterruptionBgTask()
            }
        }
    }

    private func endCallInterruptionBgTask() {
        callInterruptionTimer?.invalidate()
        callInterruptionTimer = nil
        if callInterruptionBgTaskId != .invalid {
            let id = callInterruptionBgTaskId
            callInterruptionBgTaskId = .invalid
            UIApplication.shared.endBackgroundTask(id)
            writeAppLog("NativeTTS", "endCallInterruptionBgTask: id=\(id.rawValue)")
        }
    }

    private func beginInterruptionResumeBgTask() {
        endInterruptionResumeBgTask()
        interruptionResumeBgTaskId = UIApplication.shared.beginBackgroundTask(withName: "InterruptionResume") { [weak self] in
            writeAppLog("NativeTTS", "InterruptionResume background task expired by iOS")
            self?.endInterruptionResumeBgTask()
        }
        writeAppLog("NativeTTS", "beginInterruptionResumeBgTask: id=\(interruptionResumeBgTaskId.rawValue)")
        DispatchQueue.main.async { [weak self] in
            self?.interruptionResumeTimer?.invalidate()
            self?.interruptionResumeTimer = Timer.scheduledTimer(withTimeInterval: 15.0, repeats: false) { [weak self] _ in
                writeAppLog("NativeTTS", "InterruptionResume background task 15s timeout reached")
                self?.endInterruptionResumeBgTask()
            }
        }
    }

    func endInterruptionResumeBgTask() {
        interruptionResumeTimer?.invalidate()
        interruptionResumeTimer = nil
        if interruptionResumeBgTaskId != .invalid {
            let id = interruptionResumeBgTaskId
            interruptionResumeBgTaskId = .invalid
            UIApplication.shared.endBackgroundTask(id)
            writeAppLog("NativeTTS", "endInterruptionResumeBgTask: id=\(id.rawValue)")
        }
    }

    func triggerResumeAfterInterruption() {
        self.attemptAutoResume(source: "triggerResumeAfterInterruption")
    }

    func resumeAfterInterruption() {
        self.attemptAutoResume(source: "resumeAfterInterruption")
    }

    // MARK: - Unified Auto-Resume Coordinator (Phone Calls, Alarms, Siri, Audio Interruptions)
    private func attemptAutoResume(source: String) {
        writeAppLog("NativeTTS", "attemptAutoResume called from [\(source)]: wasPlayingBeforeInterruption=\(self.wasPlayingBeforeInterruption), wasPlayingBeforeCall=\(self.wasPlayingBeforeCall), isCurrentlyPlaying=\(self.isCurrentlyPlaying), hasActiveCall=\(self.hasActiveCall)")

        guard self.wasPlayingBeforeInterruption || self.wasPlayingBeforeCall else {
            writeAppLog("NativeTTS", "attemptAutoResume [\(source)] skipped: was not playing prior to interruption/call")
            return
        }

        guard !self.isCurrentlyPlaying else {
            writeAppLog("NativeTTS", "attemptAutoResume [\(source)] skipped: already playing")
            self.wasPlayingBeforeInterruption = false
            self.wasPlayingBeforeCall = false
            return
        }

        // Clean up the call-ringing grace task since we are transitioning to resumption
        self.endCallInterruptionBgTask()

        // Keep app awake in background so timer and CoreAudio hardware route can restore
        self.beginInterruptionResumeBgTask()
        self.isAudioSessionInterrupted = false

        // Cancel previous pending resume timer if any to coalesce rapid events
        self.pendingResumeWorkItem?.cancel()

        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.pendingResumeWorkItem = nil

            // Check live CallKit state
            let anyCallActive = self.callObserver?.calls.contains(where: { !$0.hasEnded }) ?? false
            if anyCallActive {
                writeAppLog("NativeTTS", "attemptAutoResume workItem: phone call is still active in CallKit, keeping flags and deferring resume")
                return
            }

            guard !self.isCurrentlyPlaying else {
                writeAppLog("NativeTTS", "attemptAutoResume workItem: already playing, resetting flags")
                self.wasPlayingBeforeInterruption = false
                self.wasPlayingBeforeCall = false
                return
            }

            writeAppLog("NativeTTS", "attemptAutoResume workItem executing handleRemotePlay(isDirect: true)")
            self.wasPlayingBeforeInterruption = false
            self.wasPlayingBeforeCall = false
            self.hasActiveCall = false
            self.handleRemotePlay(isDirect: true)
        }

        self.pendingResumeWorkItem = workItem
        // 0.4s delay allows iOS CoreAudio telephony hardware routes to settle before activating session
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: workItem)
    }

    // MARK: - CXCallObserverDelegate (Incoming & Active Call Detection)
    private func setupCallObserver() {
        callObserver = CXCallObserver()
        callObserver?.setDelegate(self, queue: DispatchQueue.main)
    }

    public func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        let anyCallActive = callObserver.calls.contains(where: { !$0.hasEnded })
        writeAppLog("NativeTTS", "callObserver callChanged: hasEnded=\(call.hasEnded), hasConnected=\(call.hasConnected), outgoing=\(call.isOutgoing), isOnHold=\(call.isOnHold), anyCallActive=\(anyCallActive)")
        if !call.hasEnded {
            // Incoming ringing call, dialing, or connected call
            self.hasActiveCall = true
            if self.isCurrentlyPlaying {
                writeAppLog("NativeTTS", "Call active while playing -> setting wasPlayingBeforeCall=true, requesting 28s background grace period and triggering emergencyPause")
                self.wasPlayingBeforeCall = true
                self.wasPlayingBeforeInterruption = true
                self.beginCallInterruptionBgTask()
                self.emergencyPause(reason: "Phone Call (Ringing/Active)")
            }
        } else {
            // Call ended
            if !anyCallActive {
                self.hasActiveCall = false
                self.endCallInterruptionBgTask()
                writeAppLog("NativeTTS", "All calls ended in CallKit. Triggering attemptAutoResume")
                self.attemptAutoResume(source: "CallKit.callChanged")
            } else {
                writeAppLog("NativeTTS", "A call ended but another call is still active")
            }
        }
    }

    @objc func setStatusBarStyle(_ call: CAPPluginCall) {
        let style = call.getString("style") ?? "dark"
        DispatchQueue.main.async {
            if let vc = self.bridge?.viewController as? ViewController {
                vc.currentStatusBarStyle = (style == "light") ? .lightContent : .darkContent
                vc.setNeedsStatusBarAppearanceUpdate()
            }
            call.resolve()
        }
    }

    public override func load() {
        super.load()
        NativeTTS.shared = self
        setupRemoteCommands()
        setupAudioSessionObserver()
        setupCallObserver()
    }

    deinit {
        if NativeTTS.shared === self {
            NativeTTS.shared = nil
        }
        NotificationCenter.default.removeObserver(self)
        callObserver?.setDelegate(nil, queue: nil)
        callObserver = nil
        pendingResumeWorkItem?.cancel()
        pendingResumeWorkItem = nil
        endCallInterruptionBgTask()
        endInterruptionResumeBgTask()
        stopSilencePlayer()
        stopNowPlayingGuardian()
        playerA?.stop()
        playerA = nil
        playerB?.stop()
        playerB = nil
        taskLock.lock()
        for (_, workItem) in timeoutWorkItems {
            workItem.cancel()
        }
        timeoutWorkItems.removeAll()
        for (_, task) in activeTasks {
            task.cancel(with: .goingAway, reason: nil)
        }
        activeTasks.removeAll()
        taskLock.unlock()
    }

    @objc func cancelTTS(_ call: CAPPluginCall) {
        if let connectionId = call.getString("connectionId") {
            taskLock.lock()
            if let workItem = timeoutWorkItems.removeValue(forKey: connectionId) {
                workItem.cancel()
            }
            if let task = activeTasks.removeValue(forKey: connectionId) {
                task.cancel(with: .goingAway, reason: nil)
            }
            taskLock.unlock()
        }
        call.resolve()
    }

    @objc func cancelAllTTS(_ call: CAPPluginCall) {
        taskLock.lock()
        for (_, workItem) in timeoutWorkItems {
            workItem.cancel()
        }
        timeoutWorkItems.removeAll()
        for (_, task) in activeTasks {
            task.cancel(with: .goingAway, reason: nil)
        }
        activeTasks.removeAll()
        taskLock.unlock()
        call.resolve()
    }

    @objc func syncClock(_ call: CAPPluginCall) {
        guard let url = URL(string: "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4") else {
            call.resolve(["clockSkew": 0])
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 4.0
        
        let task = self.ttsSession.dataTask(with: request) { _, response, _ in
            var clockSkew: Double = 0
            if let httpResponse = response as? HTTPURLResponse,
               let dateHeader = httpResponse.allHeaderFields["Date"] as? String {
                let formatter = DateFormatter()
                formatter.locale = Locale(identifier: "en_US_POSIX")
                formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
                if let serverDate = formatter.date(from: dateHeader) {
                    clockSkew = (serverDate.timeIntervalSince(Date())) * 1000.0 // in ms
                }
            }
            call.resolve(["clockSkew": clockSkew])
        }
        task.resume()
    }

    @objc func downloadTTS(_ call: CAPPluginCall) {
        guard let text = call.getString("text"),
              let voice = call.getString("voice"),
              let connectionId = call.getString("connectionId"),
              let secMsGec = call.getString("secMsGec"),
              let dateStr = call.getString("dateStr") else {
            call.reject("Missing required parameters")
            return
        }

        let rate = call.getString("rate") ?? "+0%"
        let volume = call.getString("volume") ?? "+0%"

        let urlString = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
            "?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4" +
            "&ConnectionId=\(connectionId)" +
            "&Sec-MS-GEC=\(secMsGec)" +
            "&Sec-MS-GEC-Version=1-143.0.3650.75"

        guard let url = URL(string: urlString) else {
            call.reject("Invalid URL")
            return
        }

        var request = URLRequest(url: url)
        request.setValue("chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold", forHTTPHeaderField: "Origin")
        request.setValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0", forHTTPHeaderField: "User-Agent")

        let session = self.ttsSession
        let webSocketTask = session.webSocketTask(with: request)

        self.taskLock.lock()
        self.activeTasks[connectionId] = webSocketTask
        self.taskLock.unlock()

        var audioData = Data()
        var isCompleted = false

        var timeoutWorkItem: DispatchWorkItem?
        timeoutWorkItem = DispatchWorkItem { [weak self, weak webSocketTask] in
            guard !isCompleted else { return }
            print("[NativeTTS] Task \(connectionId) timed out after 10s")
            webSocketTask?.cancel(with: .goingAway, reason: nil)
            if let self = self {
                self.taskLock.lock()
                self.timeoutWorkItems.removeValue(forKey: connectionId)
                self.activeTasks.removeValue(forKey: connectionId)
                self.taskLock.unlock()
            }
            if !isCompleted {
                isCompleted = true
                call.reject("Edge TTS request timed out in native (10s)")
            }
        }
        if let workItem = timeoutWorkItem {
            self.taskLock.lock()
            self.timeoutWorkItems[connectionId] = workItem
            self.taskLock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + 10.0, execute: workItem)
        }

        func finishWithSuccess() {
            guard !isCompleted else { return }
            isCompleted = true
            timeoutWorkItem?.cancel()
            timeoutWorkItem = nil
            self.taskLock.lock()
            self.timeoutWorkItems.removeValue(forKey: connectionId)
            self.activeTasks.removeValue(forKey: connectionId)
            self.taskLock.unlock()
            webSocketTask.cancel(with: .normalClosure, reason: nil)
            if !audioData.isEmpty {
                // Write audio data to a temporary file instead of Base64 encoding
                // Return audioBase64 for reliable, zero-latency in-memory Blob URL playback in WebKit
                let base64 = audioData.base64EncodedString()
                let tmpDir = FileManager.default.temporaryDirectory
                let fileName = "tts_\(connectionId).mp3"
                let fileURL = tmpDir.appendingPathComponent(fileName)
                do {
                    try audioData.write(to: fileURL)
                    call.resolve(["audioBase64": base64, "filePath": fileURL.path])
                } catch {
                    call.resolve(["audioBase64": base64])
                }
            } else {
                call.reject("No audio data received from Edge TTS")
            }
        }

        func finishWithError(_ errorMsg: String) {
            guard !isCompleted else { return }
            isCompleted = true
            timeoutWorkItem?.cancel()
            timeoutWorkItem = nil
            self.taskLock.lock()
            self.timeoutWorkItems.removeValue(forKey: connectionId)
            self.activeTasks.removeValue(forKey: connectionId)
            self.taskLock.unlock()
            webSocketTask.cancel(with: .goingAway, reason: nil)
            call.reject(errorMsg)
        }

        func receiveNext() {
            webSocketTask.receive { [weak webSocketTask] result in
                guard !isCompleted else { return }
                switch result {
                case .failure(let error):
                    finishWithError("WebSocket failure: \(error.localizedDescription)")
                case .success(let message):
                    switch message {
                    case .string(let str):
                        if str.contains("Path:turn.end") {
                            finishWithSuccess()
                            return
                        }
                    case .data(let data):
                        if data.count >= 2 {
                            let headerLength = Int(data[0]) << 8 | Int(data[1])
                            if 2 + headerLength <= data.count {
                                let headerData = data.subdata(in: 2..<(2 + headerLength))
                                if let headerStr = String(data: headerData, encoding: .utf8), headerStr.contains("Path:audio") {
                                    let chunk = data.subdata(in: (2 + headerLength)..<data.count)
                                    audioData.append(chunk)
                                }
                            }
                        }
                    @unknown default:
                        break
                    }
                    receiveNext()
                }
            }
        }

        webSocketTask.resume()

        let configMsg = "X-Timestamp:\(dateStr)\r\n" +
            "Content-Type:application/json; charset=utf-8\r\n" +
            "Path:speech.config\r\n\r\n" +
            "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}"

        webSocketTask.send(.string(configMsg)) { error in
            if let error = error {
                finishWithError("Failed to send config: \(error.localizedDescription)")
                return
            }

            let escapedText = self.escapeXml(text)
            let ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
                "<voice name='\(voice)'>" +
                "<prosody pitch='+0Hz' rate='\(rate)' volume='\(volume)'>" +
                escapedText +
                "</prosody>" +
                "</voice>" +
                "</speak>"

            let ssmlMsg = "X-RequestId:\(connectionId)\r\n" +
                "Content-Type:application/ssml+xml\r\n" +
                "X-Timestamp:\(dateStr)Z\r\n" +
                "Path:ssml\r\n\r\n" +
                ssml

            webSocketTask.send(.string(ssmlMsg)) { error in
                if let error = error {
                    finishWithError("Failed to send SSML: \(error.localizedDescription)")
                }
            }
        }

        receiveNext()
    }

    // MARK: - Route B: Native Audio Engine Methods
    @objc func playNativeSentence(_ call: CAPPluginCall) {
        guard let index = call.getInt("index") else {
            call.reject("Missing index")
            return
        }

        let filePathOpt = call.getString("filePath")
        let base64Opt = call.getString("audioBase64")
        let text = call.getString("text") ?? ""
        let title = call.getString("title") ?? self.currentChapterTitle
        let artist = call.getString("artist") ?? self.currentChapterArtist
        let coverBase64 = call.getString("cover")
        let duration = call.getDouble("duration") ?? self.currentChapterTotalDuration
        let currentTime = call.getDouble("currentTime") ?? 0.0
        let rate = Float(call.getDouble("rate") ?? Double(self.currentPlaybackRate))
        let volume = Float(call.getDouble("volume") ?? Double(self.currentPlaybackVolume))

        self.currentChapterTitle = title
        self.currentChapterArtist = artist
        self.currentSentenceText = text
        self.currentChapterTotalDuration = duration
        self.currentChapterProgressBase = currentTime
        self.currentPlaybackRate = (rate > 0) ? rate : 1.0
        self.currentPlaybackVolume = (volume >= 0) ? volume : 1.0

        writeAppLog("NativeTTS", "playNativeSentence: index=\(index), file=\(filePathOpt ?? "base64"), rate=\(self.currentPlaybackRate)")

        self.activateAudioSession()
        self.isNativeEngineActive = true
        self.isCurrentlyPlaying = true
        self.wasPlayingBeforeInterruption = false
        self.isAudioSessionInterrupted = false
        self.stopSilencePlayer()
        self.endInterruptionResumeBgTask()
        self.startNowPlayingGuardian()

        // Check if preparedPlayer is already pre-warmed for this exact sentence
        if self.preparedSentenceIndex == index, let prep = self.preparedPlayer {
            writeAppLog("NativeTTS", "playNativeSentence: using pre-warmed preparedPlayer for index=\(index)")
            self.activePlayer?.stop()
            self.activePlayer = nil

            // Swap player roles
            self.activePlayerTag = self.preparedPlayerTag
            self.preparedPlayerTag = 1 - self.activePlayerTag
            self.preparedSentenceIndex = -1
            self.currentPlayingSentenceIndex = index
            self.activePlayerFilePath = self.preparedPlayerFilePath
            self.preparedPlayerFilePath = ""

            prep.rate = self.currentPlaybackRate
            prep.volume = self.currentPlaybackVolume
            prep.play()
        } else {
            // Need to initialize a new player
            self.activePlayer?.stop()
            self.activePlayer = nil

            do {
                let player: AVAudioPlayer
                if let filePath = filePathOpt, !filePath.isEmpty, FileManager.default.fileExists(atPath: filePath) {
                    player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: filePath))
                    self.activePlayerFilePath = filePath
                } else if let base64 = base64Opt, let data = Data(base64Encoded: base64) {
                    player = try AVAudioPlayer(data: data)
                    self.activePlayerFilePath = ""
                } else {
                    call.reject("No valid audio file or base64 data for index \(index)")
                    return
                }

                player.delegate = self
                player.enableRate = true
                player.rate = self.currentPlaybackRate
                player.volume = self.currentPlaybackVolume
                player.prepareToPlay()
                player.play()

                self.activePlayer = player
                self.currentPlayingSentenceIndex = index
                writeAppLog("NativeTTS", "playNativeSentence: started activePlayer for sentence \(index), duration=\(player.duration)")
            } catch {
                writeAppLog("NativeTTS", "playNativeSentence ERROR initializing AVAudioPlayer: \(error.localizedDescription)")
                call.reject("Failed to initialize AVAudioPlayer: \(error.localizedDescription)")
                return
            }
        }

        DispatchQueue.main.async {
            self.updateNowPlaying(
                title: title,
                artist: artist,
                text: text,
                isPlaying: true,
                coverBase64: coverBase64,
                duration: duration,
                currentTime: currentTime
            )
        }

        call.resolve([
            "success": true,
            "index": index,
            "duration": self.activePlayer?.duration ?? 0
        ])
    }

    @objc func prepareNextSentence(_ call: CAPPluginCall) {
        guard let index = call.getInt("index") else {
            call.reject("Missing index")
            return
        }

        let filePathOpt = call.getString("filePath")
        let base64Opt = call.getString("audioBase64")
        let rate = Float(call.getDouble("rate") ?? Double(self.currentPlaybackRate))
        let volume = Float(call.getDouble("volume") ?? Double(self.currentPlaybackVolume))

        writeAppLog("NativeTTS", "prepareNextSentence: index=\(index)")

        do {
            let player: AVAudioPlayer
            if let filePath = filePathOpt, !filePath.isEmpty, FileManager.default.fileExists(atPath: filePath) {
                player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: filePath))
                self.preparedPlayerFilePath = filePath
            } else if let base64 = base64Opt, let data = Data(base64Encoded: base64) {
                player = try AVAudioPlayer(data: data)
                self.preparedPlayerFilePath = ""
            } else {
                call.reject("No valid audio file or base64 data for prepared index \(index)")
                return
            }

            player.delegate = self
            player.enableRate = true
            player.rate = (rate > 0) ? rate : self.currentPlaybackRate
            player.volume = (volume >= 0) ? volume : self.currentPlaybackVolume
            let prepared = player.prepareToPlay() // Pre-allocates hardware CoreAudio buffers

            self.preparedPlayer?.stop()
            self.preparedPlayer = player
            self.preparedSentenceIndex = index

            writeAppLog("NativeTTS", "prepareNextSentence: successfully primed hardware buffer for sentence \(index), duration=\(player.duration)")
            call.resolve(["success": true, "index": index, "prepared": prepared])
        } catch {
            writeAppLog("NativeTTS", "prepareNextSentence ERROR: \(error.localizedDescription)")
            call.reject("Failed to prepare AVAudioPlayer: \(error.localizedDescription)")
        }
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        writeAppLog("NativeTTS", "audioPlayerDidFinishPlaying: successfully=\(flag), currentPlayingIndex=\(self.currentPlayingSentenceIndex), preparedIndex=\(self.preparedSentenceIndex)")

        guard self.isNativeEngineActive else { return }

        let finishedIndex = self.currentPlayingSentenceIndex

        // If preparedPlayer is pre-warmed for next sentence, switch instantly (0ms latency)!
        if self.isCurrentlyPlaying,
           let nextPlayer = self.preparedPlayer,
           self.preparedSentenceIndex == finishedIndex + 1 {

            nextPlayer.rate = self.currentPlaybackRate
            nextPlayer.volume = self.currentPlaybackVolume
            nextPlayer.play()

            let newIndex = self.preparedSentenceIndex
            self.activePlayerTag = self.preparedPlayerTag
            self.preparedPlayerTag = 1 - self.activePlayerTag
            self.currentPlayingSentenceIndex = newIndex
            self.preparedSentenceIndex = -1
            self.activePlayerFilePath = self.preparedPlayerFilePath
            self.preparedPlayerFilePath = ""
            self.preparedPlayer?.stop()
            self.preparedPlayer = nil

            writeAppLog("NativeTTS", "Gapless switch: started pre-warmed sentence \(newIndex)")

            // Update chapter progress on lock screen safely without exceeding total duration
            let updatedCurrentTime = Double(newIndex) * 5.0
            if updatedCurrentTime >= self.currentChapterTotalDuration - 5.0 {
                self.currentChapterTotalDuration = updatedCurrentTime + 30.0
                self.authoritativeNowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = self.currentChapterTotalDuration
            }
            self.authoritativeNowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = updatedCurrentTime
            self.syncNowPlaying(isPlaying: true)

            self.notifyListeners("sentenceStarted", data: [
                "index": newIndex,
                "duration": nextPlayer.duration
            ])
            self.notifyListeners("sentenceEnded", data: [
                "index": finishedIndex
            ])
        } else {
            writeAppLog("NativeTTS", "audioPlayerDidFinishPlaying: next sentence \(finishedIndex + 1) not prepared yet, notifying JS")
            self.notifyListeners("sentenceEnded", data: [
                "index": finishedIndex
            ])
        }
    }

    @objc func pauseNative(_ call: CAPPluginCall) {
        writeAppLog("NativeTTS", "pauseNative called from JS")
        self.pendingResumeWorkItem?.cancel()
        self.pendingResumeWorkItem = nil
        self.isCurrentlyPlaying = false
        self.stopNowPlayingGuardian()
        self.activePlayer?.pause()
        self.preparedPlayer?.pause()
        self.stopSilencePlayer()
        self.syncNowPlaying(isPlaying: false)
        call.resolve()
    }

    @objc func resumeNative(_ call: CAPPluginCall) {
        writeAppLog("NativeTTS", "resumeNative called from JS (isNativeEngineActive=\(self.isNativeEngineActive))")
        self.activateAudioSession()
        self.cancelSilencePauseTimer()
        self.stopSilencePlayer()
        self.isCurrentlyPlaying = true
        self.wasPlayingBeforeInterruption = false
        self.wasPlayingBeforeCall = false
        self.isAudioSessionInterrupted = false

        // Route B: Direct native resumption with CoreAudio re-creation fallback
        if let player = self.activePlayer {
            player.rate = self.currentPlaybackRate
            player.prepareToPlay()
            var played = player.play()
            if !played && !self.activePlayerFilePath.isEmpty && FileManager.default.fileExists(atPath: self.activePlayerFilePath) {
                let savedTime = player.currentTime
                writeAppLog("NativeTTS", "resumeNative: play() returned false, re-creating AVAudioPlayer from \(self.activePlayerFilePath) at time \(savedTime)")
                do {
                    let newPlayer = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: self.activePlayerFilePath))
                    newPlayer.delegate = self
                    newPlayer.enableRate = true
                    newPlayer.rate = self.currentPlaybackRate
                    newPlayer.volume = self.currentPlaybackVolume
                    newPlayer.currentTime = max(0, savedTime)
                    newPlayer.prepareToPlay()
                    played = newPlayer.play()
                    self.activePlayer = newPlayer
                    writeAppLog("NativeTTS", "resumeNative: re-instantiated activePlayer.play() returned \(played)")
                } catch {
                    writeAppLog("NativeTTS", "resumeNative: failed to re-instantiate activePlayer: \(error.localizedDescription)")
                }
            }
            if played {
                self.preparedPlayer?.prepareToPlay()
                self.startNowPlayingGuardian()
                self.syncNowPlaying(isPlaying: true)
                call.resolve(["resumed": true, "index": self.currentPlayingSentenceIndex])
                return
            }
        }

        if let prep = self.preparedPlayer, self.preparedSentenceIndex >= 0 {
            prep.rate = self.currentPlaybackRate
            prep.prepareToPlay()
            let played = prep.play()
            self.activePlayerTag = self.preparedPlayerTag
            self.preparedPlayerTag = 1 - self.activePlayerTag
            self.currentPlayingSentenceIndex = self.preparedSentenceIndex
            self.preparedSentenceIndex = -1
            self.activePlayerFilePath = self.preparedPlayerFilePath
            self.preparedPlayerFilePath = ""
            if played {
                self.startNowPlayingGuardian()
                self.syncNowPlaying(isPlaying: true)
                call.resolve(["resumed": true, "index": self.currentPlayingSentenceIndex])
                return
            }
        }

        if !self.activePlayerFilePath.isEmpty && FileManager.default.fileExists(atPath: self.activePlayerFilePath) {
            do {
                let newPlayer = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: self.activePlayerFilePath))
                newPlayer.delegate = self
                newPlayer.enableRate = true
                newPlayer.rate = self.currentPlaybackRate
                newPlayer.volume = self.currentPlaybackVolume
                newPlayer.prepareToPlay()
                let played = newPlayer.play()
                self.activePlayer = newPlayer
                if played {
                    self.startNowPlayingGuardian()
                    self.syncNowPlaying(isPlaying: true)
                    call.resolve(["resumed": true, "index": self.currentPlayingSentenceIndex])
                    return
                }
            } catch {
                writeAppLog("NativeTTS", "resumeNative: failed to restore from activePlayerFilePath: \(error.localizedDescription)")
            }
        }

        self.startSilencePlayer()
        self.syncNowPlaying(isPlaying: true)
        call.resolve(["resumed": false, "message": "No player ready"])
    }

    @objc func stopNative(_ call: CAPPluginCall) {
        writeAppLog("NativeTTS", "stopNative called from JS")
        self.isNativeEngineActive = false
        self.isCurrentlyPlaying = false
        self.wasPlayingBeforeInterruption = false
        self.isAudioSessionInterrupted = false
        self.currentPlayingSentenceIndex = -1
        self.preparedSentenceIndex = -1
        self.activePlayerFilePath = ""
        self.preparedPlayerFilePath = ""

        self.playerA?.stop()
        self.playerA = nil
        self.playerB?.stop()
        self.playerB = nil

        self.stopSilencePlayer()
        self.endInterruptionResumeBgTask()
        self.stopNowPlayingGuardian()
        self.updateRemoteCommandsState(isPlaying: false)
        self.authoritativeNowPlayingInfo = [:]

        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .stopped
            }
        }
        DispatchQueue.global(qos: .userInitiated).async {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        call.resolve()
    }

    @objc func setRateNative(_ call: CAPPluginCall) {
        let rate = Float(call.getDouble("rate") ?? 1.0)
        self.currentPlaybackRate = (rate > 0) ? rate : 1.0
        self.activePlayer?.rate = self.currentPlaybackRate
        self.preparedPlayer?.rate = self.currentPlaybackRate
        if self.isCurrentlyPlaying {
            self.authoritativeNowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = Double(self.currentPlaybackRate)
            self.authoritativeNowPlayingInfo[MPNowPlayingInfoPropertyDefaultPlaybackRate] = Double(self.currentPlaybackRate)
            self.syncNowPlaying(isPlaying: true)
        }
        call.resolve()
    }

    @objc func setVolumeNative(_ call: CAPPluginCall) {
        let volume = Float(call.getDouble("volume") ?? 1.0)
        self.currentPlaybackVolume = (volume >= 0) ? volume : 1.0
        self.activePlayer?.volume = self.currentPlaybackVolume
        self.preparedPlayer?.volume = self.currentPlaybackVolume
        call.resolve()
    }

    @objc func deleteTTSFile(_ call: CAPPluginCall) {
        if let filePath = call.getString("filePath") {
            if filePath != self.activePlayerFilePath && filePath != self.preparedPlayerFilePath {
                let fileURL = URL(fileURLWithPath: filePath)
                try? FileManager.default.removeItem(at: fileURL)
            }
        }
        call.resolve()
    }

    @objc func cleanupTTSFiles(_ call: CAPPluginCall) {
        let tmpDir = FileManager.default.temporaryDirectory
        if let files = try? FileManager.default.contentsOfDirectory(at: tmpDir, includingPropertiesForKeys: nil) {
            for file in files {
                if file.lastPathComponent.hasPrefix("tts_") && file.pathExtension == "mp3" {
                    try? FileManager.default.removeItem(at: file)
                }
            }
        }
        call.resolve()
    }

    @objc func getSafeAreaInsets(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var top: CGFloat = 0
            var bottom: CGFloat = 0
            var left: CGFloat = 0
            var right: CGFloat = 0
            if let window = UIApplication.shared.windows.first {
                top = window.safeAreaInsets.top
                bottom = window.safeAreaInsets.bottom
                left = window.safeAreaInsets.left
                right = window.safeAreaInsets.right
            }
            call.resolve([
                "top": top,
                "bottom": bottom,
                "left": left,
                "right": right
            ])
        }
    }

    @objc func startForegroundService(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist") ?? ""
        let text = call.getString("text")
        let isPlaying = call.getBool("isPlaying") ?? true
        let coverBase64 = call.getString("cover")
        let duration = call.getDouble("duration")
        let currentTime = call.getDouble("currentTime")

        if !self.isCurrentlyPlaying && isPlaying && (Date().timeIntervalSince1970 - self.lastRemotePauseTime < 0.6) {
            writeAppLog("NativeTTS", "startForegroundService: dropped stale isPlaying=true within 600ms of remote pause")
        } else {
            self.isCurrentlyPlaying = isPlaying
            if isPlaying {
                self.activateAudioSession()
                self.wasPlayingBeforeInterruption = false
                self.isAudioSessionInterrupted = false
                self.stopSilencePlayer()
                self.endInterruptionResumeBgTask()
                self.startNowPlayingGuardian()
            } else {
                if !self.isAudioSessionInterrupted && !self.wasPlayingBeforeInterruption {
                    self.wasPlayingBeforeInterruption = false
                    self.isAudioSessionInterrupted = false
                }
                self.stopNowPlayingGuardian()
                self.scheduleSilencePauseTimer()
            }
        }
        self.updateRemoteCommandsState(isPlaying: self.isCurrentlyPlaying)

        let effectivePlaying = self.isCurrentlyPlaying
        DispatchQueue.main.async {
            self.updateNowPlaying(title: title, artist: artist, text: text, isPlaying: effectivePlaying, coverBase64: coverBase64, duration: duration, currentTime: currentTime)
        }
        call.resolve()
    }

    @objc func updatePlaybackState(_ call: CAPPluginCall) {
        let isPlaying = call.getBool("isPlaying") ?? false
        writeAppLog("NativeTTS", "updatePlaybackState called from JS: isPlaying=\(isPlaying)")
        if !self.isCurrentlyPlaying && isPlaying && (Date().timeIntervalSince1970 - self.lastRemotePauseTime < 0.6) {
            writeAppLog("NativeTTS", "updatePlaybackState: dropped stale isPlaying=true within 600ms of remote pause")
        } else {
            self.isCurrentlyPlaying = isPlaying
            if isPlaying {
                self.activateAudioSession()
                self.wasPlayingBeforeInterruption = false
                self.isAudioSessionInterrupted = false
                self.stopSilencePlayer()
                self.endInterruptionResumeBgTask()
                self.startNowPlayingGuardian()
            } else {
                if !self.isAudioSessionInterrupted && !self.wasPlayingBeforeInterruption {
                    self.wasPlayingBeforeInterruption = false
                    self.isAudioSessionInterrupted = false
                }
                self.stopNowPlayingGuardian()
                self.scheduleSilencePauseTimer()
            }
            self.syncNowPlaying(isPlaying: isPlaying)
        }
        call.resolve()
    }

    @objc func updateMetadata(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist") ?? ""
        let text = call.getString("text")
        let coverBase64 = call.getString("cover")
        let duration = call.getDouble("duration")
        let currentTime = call.getDouble("currentTime")
        if let callIsPlaying = call.getBool("isPlaying") {
            // Guard: If native is already paused by remote command, do not let an asynchronous in-flight metadata update revive playing state!
            if !self.isCurrentlyPlaying && callIsPlaying && (Date().timeIntervalSince1970 - self.lastRemotePauseTime < 0.6) {
                writeAppLog("NativeTTS", "updateMetadata: dropped stale callIsPlaying=true within 600ms of remote pause")
            } else {
                self.isCurrentlyPlaying = callIsPlaying
                if callIsPlaying {
                    self.activateAudioSession()
                    self.wasPlayingBeforeInterruption = false
                    self.isAudioSessionInterrupted = false
                    self.stopSilencePlayer()
                    self.endInterruptionResumeBgTask()
                    self.startNowPlayingGuardian()
                } else {
                    if !self.isAudioSessionInterrupted && !self.wasPlayingBeforeInterruption {
                        self.wasPlayingBeforeInterruption = false
                        self.isAudioSessionInterrupted = false
                    }
                    self.stopNowPlayingGuardian()
                    self.scheduleSilencePauseTimer()
                }
            }
        }
        let isPlaying = self.isCurrentlyPlaying
        DispatchQueue.main.async {
            self.updateNowPlaying(title: title, artist: artist, text: text, isPlaying: isPlaying, coverBase64: coverBase64, duration: duration, currentTime: currentTime)
        }
        call.resolve()
    }

    @objc func stopForegroundService(_ call: CAPPluginCall) {
        self.wasPlayingBeforeInterruption = false
        self.isCurrentlyPlaying = false
        self.currentArtwork = nil
        self.authoritativeNowPlayingInfo = [:]
        self.stopSilencePlayer()
        self.endInterruptionResumeBgTask()
        self.stopNowPlayingGuardian()
        self.updateRemoteCommandsState(isPlaying: false)
        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .stopped
            }
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            } catch {
                print("[NativeTTS] Failed to deactivate AVAudioSession on stop: \(error)")
            }
        }
        call.resolve()
    }

    @objc func getPlaybackSyncState(_ call: CAPPluginCall) {
        let rate = MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] as? Double ?? -1.0
        let title = MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyTitle] as? String ?? ""
        var stateStr = "unknown"
        if #available(iOS 13.0, *) {
            switch MPNowPlayingInfoCenter.default().playbackState {
            case .playing: stateStr = "playing"
            case .paused: stateStr = "paused"
            case .stopped: stateStr = "stopped"
            case .interrupted: stateStr = "interrupted"
            default: stateStr = "unknown"
            }
        }
        call.resolve([
            "isCurrentlyPlaying": self.isCurrentlyPlaying,
            "isNativeEngineActive": self.isNativeEngineActive,
            "currentPlayingSentenceIndex": self.currentPlayingSentenceIndex,
            "preparedSentenceIndex": self.preparedSentenceIndex,
            "nativePlayerPlaying": (self.activePlayer?.isPlaying ?? false),
            "silencePlayerRunning": (self.silencePlayer?.isPlaying ?? false),
            "playbackState": stateStr,
            "playbackRate": rate,
            "nowPlayingTitle": title
        ])
    }

    @objc func simulateRemoteCommand(_ call: CAPPluginCall) {
        guard let action = call.getString("action")?.lowercased() else {
            call.reject("Missing action")
            return
        }
        print("[NativeTTS] Simulating RemoteCommand: \(action)")
        switch action {
        case "play":
            self.handleRemotePlay()
        case "pause":
            self.handleRemotePause()
        case "toggle":
            self.handleRemoteTogglePlayPause()
        case "next":
            self.handleRemoteNext()
        case "previous":
            self.handleRemotePrevious()
        case "stop":
            self.handleRemoteStop()
        case "call_incoming":
            NotificationCenter.default.post(
                name: AVAudioSession.interruptionNotification,
                object: nil,
                userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue]
            )
        case "call_ended":
            NotificationCenter.default.post(
                name: AVAudioSession.interruptionNotification,
                object: nil,
                userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue]
            )
        default:
            call.reject("Unknown action: \(action)")
            return
        }
        call.resolve()
    }

    @objc func createZipFromDirectory(_ call: CAPPluginCall) {
        guard let sourcePath = call.getString("sourcePath"),
              let outputFilename = call.getString("outputFilename") else {
            call.reject("Missing sourcePath or outputFilename")
            return
        }

        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let sourceURL = cacheDir.appendingPathComponent(sourcePath)
        let outputURL = cacheDir.appendingPathComponent(outputFilename)

        guard FileManager.default.fileExists(atPath: sourceURL.path) else {
            call.reject("Source directory does not exist: \(sourceURL.path)")
            return
        }

        try? FileManager.default.removeItem(at: outputURL)

        var coordError: NSError?
        let coordinator = NSFileCoordinator()
        coordinator.coordinate(readingItemAt: sourceURL, options: .forUploading, error: &coordError) { zipURL in
            do {
                try FileManager.default.copyItem(at: zipURL, to: outputURL)
                call.resolve(["uri": outputURL.absoluteString])
            } catch {
                call.reject("Failed to save zip archive: \(error.localizedDescription)")
            }
        }

        if let error = coordError {
            call.reject("ZIP creation failed: \(error.localizedDescription)")
        }
    }

    @objc func saveFileToSystem(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func copyFileToDownloads(_ call: CAPPluginCall) {
        call.resolve()
    }

    private func getCoverData(from base64String: String?) -> Data? {
        guard let base64String = base64String, !base64String.isEmpty else { return nil }
        var cleanBase64 = base64String.trimmingCharacters(in: .whitespacesAndNewlines)
        if let commaIndex = cleanBase64.firstIndex(of: ",") {
            cleanBase64 = String(cleanBase64[cleanBase64.index(after: commaIndex)...])
        }
        cleanBase64 = cleanBase64.trimmingCharacters(in: .whitespacesAndNewlines)
        return Data(base64Encoded: cleanBase64, options: .ignoreUnknownCharacters)
    }

    private func updateNowPlaying(title: String, artist: String, text: String? = nil, isPlaying: Bool, coverBase64: String? = nil, duration: Double? = nil, currentTime: Double? = nil) {
        if let coverData = getCoverData(from: coverBase64), let image = UIImage(data: coverData), image.size.width > 0 && image.size.height > 0 {
            self.currentArtwork = MPMediaItemArtwork(boundsSize: image.size) { _ in return image }
        }
        
        var nowPlayingInfo = self.authoritativeNowPlayingInfo
        let displayTitle = (text != nil && !text!.isEmpty) ? text! : (title.isEmpty ? "TTS Reading" : title)
        nowPlayingInfo[MPMediaItemPropertyTitle] = displayTitle
        if !title.isEmpty && displayTitle != title {
            nowPlayingInfo[MPMediaItemPropertyAlbumTitle] = title
        }
        nowPlayingInfo[MPMediaItemPropertyArtist] = artist.isEmpty ? "E-Book Reader" : artist
        nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        nowPlayingInfo[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0

        let validDuration = (duration != nil && duration! > 0) ? duration! : (nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] as? Double ?? 60.0)
        let validCurrentTime = (currentTime != nil && currentTime! >= 0) ? currentTime! : 0.0
        let safeDuration = max(validDuration, validCurrentTime + 5.0)

        nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = safeDuration
        nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = validCurrentTime
        
        self.currentChapterTotalDuration = safeDuration
        self.currentChapterProgressBase = validCurrentTime

        if let artwork = self.currentArtwork {
            nowPlayingInfo[MPMediaItemPropertyArtwork] = artwork
        }
        
        self.authoritativeNowPlayingInfo = nowPlayingInfo
        self.syncNowPlaying(isPlaying: isPlaying)
    }

    private func setupAudioSessionObserver() {
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.routeChangeNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIApplication.didBecomeActiveNotification, object: nil)

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioSessionInterruption(notification:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioRouteChange(notification:)),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleApplicationDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleApplicationDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    @objc private func handleApplicationDidEnterBackground() {
        if !self.isCurrentlyPlaying {
            self.stopNowPlayingGuardian()
            self.syncNowPlaying(isPlaying: false)
        } else {
            self.syncNowPlaying(isPlaying: true)
        }
    }

    @objc private func handleApplicationDidBecomeActive() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            writeAppLog("NativeTTS", "handleApplicationDidBecomeActive: wasPlayingBeforeInterruption=\(self.wasPlayingBeforeInterruption), wasPlayingBeforeCall=\(self.wasPlayingBeforeCall), isCurrentlyPlaying=\(self.isCurrentlyPlaying)")
            if (self.wasPlayingBeforeInterruption || self.wasPlayingBeforeCall) && !self.isCurrentlyPlaying {
                self.attemptAutoResume(source: "ApplicationDidBecomeActive")
            }
        }
    }

    @objc private func handleAudioRouteChange(notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let userInfo = notification.userInfo,
                  let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
                return
            }
            writeAppLog("NativeTTS", "Audio route changed: reason=\(reason.rawValue)")

            // 遵循 iOS 官方防扰民规范：拔出耳机或断开蓝牙耳机时，立即执行暂停
            if reason == .oldDeviceUnavailable {
                writeAppLog("NativeTTS", "Audio route changed: old device unavailable (headphone disconnected)")
                self.handleRemotePause(isDirect: true)
            } else if (self.wasPlayingBeforeCall || self.wasPlayingBeforeInterruption) && !self.isCurrentlyPlaying {
                // iOS 16+ multi-source recovery: route switch back from telephony/ringer to media
                writeAppLog("NativeTTS", "Audio route changed while interrupted (reason=\(reason.rawValue)) -> triggering attemptAutoResume")
                self.attemptAutoResume(source: "AudioRouteChange")
            }
        }
    }

    @objc private func handleAudioSessionInterruption(notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let userInfo = notification.userInfo,
                  let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
                return
            }

            switch type {
            case .began:
                writeAppLog("NativeTTS", "Audio session interruption began. isCurrentlyPlaying=\(self.isCurrentlyPlaying)")
                self.isAudioSessionInterrupted = true
                if self.isCurrentlyPlaying {
                    self.wasPlayingBeforeInterruption = true
                    self.wasPlayingBeforeCall = true
                    self.beginCallInterruptionBgTask()
                }
                self.emergencyPause(reason: "AVAudioSession Interruption Began")

            case .ended:
                self.endCallInterruptionBgTask()
                var shouldResumeFlag = false
                if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                    let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                    shouldResumeFlag = options.contains(.shouldResume)
                }
                writeAppLog("NativeTTS", "Audio session interruption ended. wasPlayingBeforeInterruption=\(self.wasPlayingBeforeInterruption), wasPlayingBeforeCall=\(self.wasPlayingBeforeCall), shouldResumeOption=\(shouldResumeFlag)")
                self.attemptAutoResume(source: "AudioSession.interruptionEnded")

            @unknown default:
                break
            }
        }
    }

    // MARK: - Remote Control Handlers (Handles both MPRemoteCommandCenter and Bluetooth UIEvent)
    func handleRemotePlay(isDirect: Bool = false) {
        if !isDirect && shouldThrottleRemoteCommand(type: "play") { return }
        self.pendingResumeWorkItem?.cancel()
        self.pendingResumeWorkItem = nil
        writeAppLog("NativeTTS", "handleRemotePlay BEGIN (isNativeEngineActive=\(self.isNativeEngineActive))")
        let activated = self.activateAudioSession()
        if !activated {
            writeAppLog("NativeTTS", "handleRemotePlay: initial activateAudioSession returned false, scheduling retry in 200ms")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                self?.activateAudioSession()
            }
        }
        self.cancelSilencePauseTimer()
        self.stopSilencePlayer()
        self.isCurrentlyPlaying = true
        self.wasPlayingBeforeInterruption = false
        self.wasPlayingBeforeCall = false
        self.isAudioSessionInterrupted = false
        self.endCallInterruptionBgTask()
        self.endInterruptionResumeBgTask()

        // Route B: Direct native resumption within 0ms
        if self.isNativeEngineActive, let player = self.activePlayer {
            player.rate = self.currentPlaybackRate
            player.prepareToPlay()
            var played = player.play()
            if !played && !self.activePlayerFilePath.isEmpty && FileManager.default.fileExists(atPath: self.activePlayerFilePath) {
                let savedTime = player.currentTime
                writeAppLog("NativeTTS", "handleRemotePlay: play() failed, re-creating AVAudioPlayer from \(self.activePlayerFilePath) at time \(savedTime)")
                do {
                    let newPlayer = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: self.activePlayerFilePath))
                    newPlayer.delegate = self
                    newPlayer.enableRate = true
                    newPlayer.rate = self.currentPlaybackRate
                    newPlayer.volume = self.currentPlaybackVolume
                    newPlayer.currentTime = max(0, savedTime)
                    newPlayer.prepareToPlay()
                    played = newPlayer.play()
                    self.activePlayer = newPlayer
                    writeAppLog("NativeTTS", "handleRemotePlay: re-instantiated activePlayer.play() returned \(played)")
                } catch {
                    writeAppLog("NativeTTS", "handleRemotePlay: failed to re-instantiate activePlayer: \(error.localizedDescription)")
                }
            }
            if !played {
                writeAppLog("NativeTTS", "handleRemotePlay: player.play() returned false, scheduling fallback retry in 250ms")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                    guard let self = self, self.isCurrentlyPlaying else { return }
                    self.activateAudioSession()
                    let retryPlayed = self.activePlayer?.play() ?? false
                    writeAppLog("NativeTTS", "handleRemotePlay: fallback retry player.play() returned \(retryPlayed)")
                }
            }
            self.preparedPlayer?.prepareToPlay()
            writeAppLog("NativeTTS", "handleRemotePlay: native activePlayer.play() returned \(played)")
            self.startNowPlayingGuardian()
            self.syncNowPlaying(isPlaying: true)
            self.notifyListeners("mediaAction", data: ["action": "play"])
            DispatchQueue.main.async { [weak self] in
                self?.bridge?.webView?.evaluateJavaScript(
                    "if (window.tts) { window.tts._resumeFromNative = true; window.tts.resume(); window.tts._resumeFromNative = false; }",
                    completionHandler: nil
                )
            }
            return
        } else if self.isNativeEngineActive, let prep = self.preparedPlayer, self.preparedSentenceIndex >= 0 {
            prep.rate = self.currentPlaybackRate
            prep.prepareToPlay()
            let played = prep.play()
            self.activePlayerTag = self.preparedPlayerTag
            self.preparedPlayerTag = 1 - self.activePlayerTag
            self.currentPlayingSentenceIndex = self.preparedSentenceIndex
            self.preparedSentenceIndex = -1
            self.activePlayerFilePath = self.preparedPlayerFilePath
            self.preparedPlayerFilePath = ""
            writeAppLog("NativeTTS", "handleRemotePlay: native preparedPlayer.play() returned \(played)")
            self.startNowPlayingGuardian()
            self.syncNowPlaying(isPlaying: true)
            self.notifyListeners("mediaAction", data: ["action": "play"])
            DispatchQueue.main.async { [weak self] in
                self?.bridge?.webView?.evaluateJavaScript(
                    "if (window.tts) { window.tts._resumeFromNative = true; window.tts.resume(); window.tts._resumeFromNative = false; }",
                    completionHandler: nil
                )
            }
            return
        } else if self.isNativeEngineActive, !self.activePlayerFilePath.isEmpty, FileManager.default.fileExists(atPath: self.activePlayerFilePath) {
            do {
                let newPlayer = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: self.activePlayerFilePath))
                newPlayer.delegate = self
                newPlayer.enableRate = true
                newPlayer.rate = self.currentPlaybackRate
                newPlayer.volume = self.currentPlaybackVolume
                newPlayer.prepareToPlay()
                let played = newPlayer.play()
                self.activePlayer = newPlayer
                writeAppLog("NativeTTS", "handleRemotePlay: activePlayer was nil, re-instantiated from activePlayerFilePath. play() returned \(played)")
                self.startNowPlayingGuardian()
                self.syncNowPlaying(isPlaying: true)
                self.notifyListeners("mediaAction", data: ["action": "play"])
                DispatchQueue.main.async { [weak self] in
                    self?.bridge?.webView?.evaluateJavaScript(
                        "if (window.tts) { window.tts._resumeFromNative = true; window.tts.resume(); window.tts._resumeFromNative = false; }",
                        completionHandler: nil
                    )
                }
                return
            } catch {
                writeAppLog("NativeTTS", "handleRemotePlay: failed to restore from activePlayerFilePath: \(error.localizedDescription)")
            }
        }

        // Fallback for HTML5 / WebKit audio path
        self.startSilencePlayer()
        self.startNowPlayingGuardian()
        self.syncNowPlaying(isPlaying: true)

        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ResumePlayback") {
            if bgTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(bgTaskId)
                bgTaskId = .invalid
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10.0) {
            if bgTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(bgTaskId)
                bgTaskId = .invalid
            }
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                if bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(bgTaskId)
                    bgTaskId = .invalid
                }
                return
            }
            writeAppLog("NativeTTS", "handleRemotePlay: evaluating JS resume in webView...")
            self.bridge?.webView?.evaluateJavaScript(
                "if (window.tts) { window.tts._resumeFromNative = true; window.tts.resume(); window.tts._resumeFromNative = false; 'RESUMED_SUCCESS'; }",
                completionHandler: { res, err in
                    if let err = err {
                        writeAppLog("NativeTTS", "handleRemotePlay evaluateJS ERROR: \(err.localizedDescription)")
                    } else {
                        writeAppLog("NativeTTS", "handleRemotePlay evaluateJS RESULT: \(res ?? "nil")")
                    }
                }
            )
            self.notifyListeners("mediaAction", data: ["action": "play"])
        }
    }

    func handleRemotePause(isDirect: Bool = false) {
        if !isDirect && shouldThrottleRemoteCommand(type: "pause") { return }
        self.pendingResumeWorkItem?.cancel()
        self.pendingResumeWorkItem = nil
        self.endCallInterruptionBgTask()
        self.endInterruptionResumeBgTask()
        self.lastRemotePauseTime = Date().timeIntervalSince1970
        writeAppLog("NativeTTS", "handleRemotePause BEGIN, was isCurrentlyPlaying=\(self.isCurrentlyPlaying), isNativeEngineActive=\(self.isNativeEngineActive)")
        self.isCurrentlyPlaying = false
        self.wasPlayingBeforeInterruption = false
        self.wasPlayingBeforeCall = false
        self.isAudioSessionInterrupted = false
        self.stopNowPlayingGuardian()

        // Route B: Direct native pause within 0ms
        if self.isNativeEngineActive {
            self.activePlayer?.pause()
            self.preparedPlayer?.pause()
            self.stopSilencePlayer()
            self.syncNowPlaying(isPlaying: false)
            self.notifyListeners("mediaAction", data: ["action": "pause"])
            DispatchQueue.main.async { [weak self] in
                self?.bridge?.webView?.evaluateJavaScript(
                    "if (window.tts) { window.tts._pauseFromNative = true; window.tts.pause(); window.tts._pauseFromNative = false; }",
                    completionHandler: nil
                )
            }
            return
        }

        // Fallback for HTML5 / WebKit audio path
        self.scheduleSilencePauseTimer()
        self.syncNowPlaying(isPlaying: false)

        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "RemotePausePlayback") {
            if bgTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(bgTaskId)
                bgTaskId = .invalid
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6.0) {
            if bgTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(bgTaskId)
                bgTaskId = .invalid
            }
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                if bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(bgTaskId)
                    bgTaskId = .invalid
                }
                return
            }
            writeAppLog("NativeTTS", "handleRemotePause: evaluating JS pause in webView...")
            let jsCode = """
            (function() {
                if (window.tts) {
                    window.tts._pauseFromNative = true;
                    window.tts.pause();
                    window.tts._pauseFromNative = false;
                }
                var audios = document.querySelectorAll('audio');
                audios.forEach(function(a) { try { a.pause(); } catch(e) {} });
                return 'PAUSED_COUNT_' + audios.length;
            })();
            """
            self.bridge?.webView?.evaluateJavaScript(jsCode) { result, error in
                if let error = error {
                    writeAppLog("NativeTTS", "handleRemotePause evaluateJS ERROR: \(error.localizedDescription)")
                } else {
                    writeAppLog("NativeTTS", "handleRemotePause evaluateJS RESULT: \(result ?? "nil")")
                }
                if bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(bgTaskId)
                    bgTaskId = .invalid
                }
            }
            self.notifyListeners("mediaAction", data: ["action": "pause"])
        }
    }

    func handleRemoteTogglePlayPause() {
        if shouldThrottleRemoteCommand(type: "toggle") { return }
        writeAppLog("NativeTTS", "handleRemoteTogglePlayPause BEGIN, isCurrentlyPlaying=\(self.isCurrentlyPlaying)")
        let shouldPlay = !self.isCurrentlyPlaying
        if shouldPlay {
            self.handleRemotePlay(isDirect: true)
        } else {
            self.handleRemotePause(isDirect: true)
        }
    }

    func handleRemoteNext() {
        if shouldThrottleRemoteCommand(type: "next") { return }
        writeAppLog("NativeTTS", "handleRemoteNext BEGIN")
        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "NextTrack") {
            if bgTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(bgTaskId)
                bgTaskId = .invalid
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6.0) {
            if bgTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(bgTaskId)
                bgTaskId = .invalid
            }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.bridge?.webView?.evaluateJavaScript("if (window.tts) { window.tts.next(); }", completionHandler: nil)
            self.notifyListeners("mediaAction", data: ["action": "next"])
        }
    }

    func handleRemotePrevious() {
        if shouldThrottleRemoteCommand(type: "previous") { return }
        writeAppLog("NativeTTS", "handleRemotePrevious BEGIN")
        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "PreviousTrack") {
            if bgTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(bgTaskId)
                bgTaskId = .invalid
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6.0) {
            if bgTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(bgTaskId)
                bgTaskId = .invalid
            }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.bridge?.webView?.evaluateJavaScript("if (window.tts) { window.tts.previous(); }", completionHandler: nil)
            self.notifyListeners("mediaAction", data: ["action": "previous"])
        }
    }

    func handleRemoteStop() {
        if shouldThrottleRemoteCommand(type: "stop") { return }
        writeAppLog("NativeTTS", "handleRemoteStop BEGIN")
        self.isCurrentlyPlaying = false
        self.wasPlayingBeforeInterruption = false
        self.wasPlayingBeforeCall = false
        self.isAudioSessionInterrupted = false
        self.stopSilencePlayer()
        self.endInterruptionResumeBgTask()
        self.stopNowPlayingGuardian()
        self.updateRemoteCommandsState(isPlaying: false)
        self.authoritativeNowPlayingInfo = [:]

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .stopped
            }
            self.bridge?.webView?.evaluateJavaScript("if (window.tts) { window.tts.stop(); } else { document.querySelectorAll('audio').forEach(function(a) { a.pause(); }); }", completionHandler: nil)
            self.notifyListeners("mediaAction", data: ["action": "stop"])
        }
        DispatchQueue.global(qos: .userInitiated).async {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private func setupRemoteCommands() {
        let commandCenter = MPRemoteCommandCenter.shared()
        commandCenter.playCommand.removeTarget(nil)
        commandCenter.pauseCommand.removeTarget(nil)
        commandCenter.stopCommand.removeTarget(nil)
        commandCenter.togglePlayPauseCommand.removeTarget(nil)
        commandCenter.nextTrackCommand.removeTarget(nil)
        commandCenter.previousTrackCommand.removeTarget(nil)

        self.updateRemoteCommandsState(isPlaying: self.isCurrentlyPlaying)
        commandCenter.stopCommand.isEnabled = true
        commandCenter.nextTrackCommand.isEnabled = true
        commandCenter.previousTrackCommand.isEnabled = true

        commandCenter.playCommand.addTarget { [weak self] _ in
            self?.lastMPRemoteCommandTime = Date().timeIntervalSince1970
            writeAppLog("MPRemoteCommandCenter", "playCommand triggered")
            self?.handleRemotePlay()
            return .success
        }

        commandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.lastMPRemoteCommandTime = Date().timeIntervalSince1970
            writeAppLog("MPRemoteCommandCenter", "pauseCommand triggered")
            self?.handleRemotePause()
            return .success
        }

        commandCenter.stopCommand.addTarget { [weak self] _ in
            self?.lastMPRemoteCommandTime = Date().timeIntervalSince1970
            writeAppLog("MPRemoteCommandCenter", "stopCommand triggered")
            self?.handleRemoteStop()
            return .success
        }

        commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.lastMPRemoteCommandTime = Date().timeIntervalSince1970
            writeAppLog("MPRemoteCommandCenter", "togglePlayPauseCommand triggered")
            self?.handleRemoteTogglePlayPause()
            return .success
        }

        commandCenter.nextTrackCommand.addTarget { [weak self] _ in
            self?.lastMPRemoteCommandTime = Date().timeIntervalSince1970
            writeAppLog("MPRemoteCommandCenter", "nextTrackCommand triggered")
            self?.handleRemoteNext()
            return .success
        }

        commandCenter.previousTrackCommand.addTarget { [weak self] _ in
            self?.lastMPRemoteCommandTime = Date().timeIntervalSince1970
            writeAppLog("MPRemoteCommandCenter", "previousTrackCommand triggered")
            self?.handleRemotePrevious()
            return .success
        }
    }

    private func escapeXml(_ unsafe: String) -> String {
        return unsafe.replacingOccurrences(of: "&", with: "&amp;")
                     .replacingOccurrences(of: "<", with: "&lt;")
                     .replacingOccurrences(of: ">", with: "&gt;")
                     .replacingOccurrences(of: "\"", with: "&quot;")
                     .replacingOccurrences(of: "'", with: "&apos;")
    }
}
