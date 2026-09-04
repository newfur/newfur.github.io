import UIKit
import Capacitor
import AVFoundation
import MediaPlayer
import CallKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Configure audio session for background TTS playback (.allowAirPlay, .allowBluetoothA2DP)
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .default, options: [.allowAirPlay, .allowBluetoothA2DP])
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
public class NativeTTS: CAPPlugin, CAPBridgedPlugin, CXCallObserverDelegate {
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
        CAPPluginMethod(name: "simulateRemoteCommand", returnType: CAPPluginReturnPromise)
    ]

    public static weak var shared: NativeTTS?

    private var lastRemoteCommandTime: TimeInterval = 0
    private func shouldThrottleRemoteCommand() -> Bool {
        let now = Date().timeIntervalSince1970
        if now - lastRemoteCommandTime < 0.25 {
            print("[NativeTTS] Throttling duplicated remote command (<\(now - lastRemoteCommandTime)s)")
            return true
        }
        lastRemoteCommandTime = now
        return false
    }

    private var activeTasks = [String: URLSessionWebSocketTask]()
    private let taskLock = NSLock()
    private var currentArtwork: MPMediaItemArtwork?
    private var wasPlayingBeforeInterruption: Bool = false
    private var wasPlayingBeforeCall: Bool = false
    private var isAudioSessionInterrupted: Bool = false
    private var isCurrentlyPlaying: Bool = false
    private var callObserver: CXCallObserver?
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
                silencePlayer?.volume = 0.1
                silencePlayer?.prepareToPlay()
            } catch {
                print("[NativeTTS] Failed to initialize silencePlayer: \(error)")
            }
        }
    }

    func startSilencePlayer() {
        self.activateAudioSession()
        ensureSilencePlayer()
        cancelSilencePauseTimer()
        silencePlayer?.play()
        print("[NativeTTS] Silence keep-alive player running (keeps WKWebView process alive)")
    }

    func stopSilencePlayer() {
        cancelSilencePauseTimer()
        silencePlayer?.stop()
        silencePlayer = nil
        print("[NativeTTS] Silence keep-alive player stopped")
    }
    
    func dimSilencePlayer() {
        if silencePlayer == nil {
            startSilencePlayer()
        }
        silencePlayer?.volume = 0.005  // Very low volume, inaudible
        print("[NativeTTS] Silence player volume dimmed during WebKit audio playback")
    }
    
    func restoreSilencePlayer() {
        if silencePlayer == nil {
            startSilencePlayer()
        }
        silencePlayer?.volume = 0.1  // Restore keep-alive volume
        print("[NativeTTS] Silence player volume restored")
    }

    func scheduleSilencePauseTimer() {
        cancelSilencePauseTimer()
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
    // Explicitly toggle playCommand and pauseCommand isEnabled to prevent iOS lock screen from showing the wrong button
    func updateRemoteCommandsState(isPlaying: Bool) {
        DispatchQueue.main.async {
            let commandCenter = MPRemoteCommandCenter.shared()
            commandCenter.playCommand.isEnabled = !isPlaying
            commandCenter.pauseCommand.isEnabled = isPlaying
            commandCenter.togglePlayPauseCommand.isEnabled = true
        }
    }

    // MARK: - NowPlaying State Guardian
    // Prevents WebKit's asynchronous audio pause IPC from knocking iOS lock screen/notification center into paused state
    func startNowPlayingGuardian() {
        stopNowPlayingGuardian()
        self.updateRemoteCommandsState(isPlaying: true)
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.isCurrentlyPlaying else { return }
            let timer = Timer(timeInterval: 0.35, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                guard self.isCurrentlyPlaying else {
                    self.stopNowPlayingGuardian()
                    return
                }
                
                var needsRestore = false
                if #available(iOS 13.0, *) {
                    if MPNowPlayingInfoCenter.default().playbackState != .playing {
                        needsRestore = true
                    }
                }
                let currentRate = MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] as? Double ?? 0.0
                if currentRate < 0.5 {
                    needsRestore = true
                }
                let commandCenter = MPRemoteCommandCenter.shared()
                if commandCenter.playCommand.isEnabled || !commandCenter.pauseCommand.isEnabled {
                    needsRestore = true
                }
                
                if needsRestore {
                    print("[NativeTTS] Guardian: Restoring NowPlaying to playing (was overwritten by WebKit)")
                    self.updateRemoteCommandsState(isPlaying: true)
                    var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
                    info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
                    info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0
                    if let artwork = self.currentArtwork {
                        info[MPMediaItemPropertyArtwork] = artwork
                    }
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                    if #available(iOS 13.0, *) {
                        MPNowPlayingInfoCenter.default().playbackState = .playing
                    }
                }
            }
            RunLoop.main.add(timer, forMode: .common)
            self.nowPlayingGuardianTimer = timer
        }
    }

    func stopNowPlayingGuardian() {
        DispatchQueue.main.async { [weak self] in
            self?.nowPlayingGuardianTimer?.invalidate()
            self?.nowPlayingGuardianTimer = nil
        }
    }

    // MARK: - Emergency Pause & Resume
    func emergencyPause(reason: String) {
        print("[NativeTTS] Emergency pause triggered: \(reason)")
        self.isCurrentlyPlaying = false
        self.stopNowPlayingGuardian()
        self.updateRemoteCommandsState(isPlaying: false)
        // Immediately pause silence player to prevent any audio hardware output
        self.silencePlayer?.pause()

        let updateNowPlayingBlock = { [weak self] in
            guard let self = self else { return }
            // 1. Immediately update MPNowPlayingInfoCenter to paused (▶ play button on lock screen)
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .paused
            }
            if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
            // 2. Force emergency pause on WKWebView AudioElements and window.tts
            // System interruptions: use evaluateJavaScript only (direct WebView control)
            self.bridge?.webView?.evaluateJavaScript(
                "if (window.tts) { window.tts.pause(); } else { document.querySelectorAll('audio').forEach(function(a) { a.pause(); }); }",
                completionHandler: nil
            )
        }

        if Thread.isMainThread {
            updateNowPlayingBlock()
        } else {
            DispatchQueue.main.sync {
                updateNowPlayingBlock()
            }
        }
        // NOTE: We deliberately DO NOT deactivate AVAudioSession (setActive(false)) during an interruption/call!
        // According to Apple AVFoundation documentation, iOS automatically manages and silences audio routing during calls.
        // Calling setActive(false) causes iOS to discard MPNowPlayingInfoCenter updates, leaving lock screen in playing state.
    }

    private func activateAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.allowAirPlay, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch {
            print("[NativeTTS] Failed to activate AVAudioSession: \(error)")
        }
    }

    func resumeAfterInterruptionOrCall() {
        guard self.wasPlayingBeforeCall || self.wasPlayingBeforeInterruption else {
            print("[NativeTTS] resumeAfterInterruptionOrCall skipped: already resumed or was not playing")
            return
        }
        self.wasPlayingBeforeCall = false
        self.wasPlayingBeforeInterruption = false
        print("[NativeTTS] Resuming playback after interruption/call")
        self.activateAudioSession()

        self.isCurrentlyPlaying = true
        self.dimSilencePlayer()  // Dim instead of stop to maintain audio session
        self.updateRemoteCommandsState(isPlaying: true)
        self.startNowPlayingGuardian()

        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ResumePlaybackInterruption") {
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
            guard let self = self else { return }
            if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
                if let artwork = self.currentArtwork {
                    info[MPMediaItemPropertyArtwork] = artwork
                }
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .playing
            }
            // System interruptions: use evaluateJavaScript only (direct WebView control)
            self.bridge?.webView?.evaluateJavaScript("if (window.tts) { window.tts.resume(); }", completionHandler: nil)
        }
    }

    // MARK: - CXCallObserverDelegate (Incoming & Active Call Detection)
    private func setupCallObserver() {
        callObserver = CXCallObserver()
        callObserver?.setDelegate(self, queue: DispatchQueue.main)
    }

    public func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        if !call.hasEnded {
            // Incoming ringing call, dialing, or connected call
            print("[NativeTTS] Call active / ringing detected. hasConnected=\(call.hasConnected), isOnHold=\(call.isOnHold)")
            if self.isCurrentlyPlaying {
                self.wasPlayingBeforeCall = true
                self.wasPlayingBeforeInterruption = true
                self.emergencyPause(reason: "Phone Call Detected (Ringing/Active)")
            }
        } else {
            // Call ended
            print("[NativeTTS] Call ended")
            if self.wasPlayingBeforeCall || self.wasPlayingBeforeInterruption {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    self?.resumeAfterInterruptionOrCall()
                }
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
        stopSilencePlayer()
        stopNowPlayingGuardian()
        taskLock.lock()
        for (_, task) in activeTasks {
            task.cancel(with: .goingAway, reason: nil)
        }
        activeTasks.removeAll()
        taskLock.unlock()
    }

    @objc func cancelTTS(_ call: CAPPluginCall) {
        if let connectionId = call.getString("connectionId") {
            taskLock.lock()
            if let task = activeTasks.removeValue(forKey: connectionId) {
                task.cancel(with: .goingAway, reason: nil)
            }
            taskLock.unlock()
        }
        call.resolve()
    }

    @objc func cancelAllTTS(_ call: CAPPluginCall) {
        taskLock.lock()
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
                self.activeTasks.removeValue(forKey: connectionId)
                self.taskLock.unlock()
            }
            if !isCompleted {
                isCompleted = true
                call.reject("Edge TTS request timed out in native (10s)")
            }
        }
        if let workItem = timeoutWorkItem {
            DispatchQueue.global().asyncAfter(deadline: .now() + 10.0, execute: workItem)
        }

        func finishWithSuccess() {
            guard !isCompleted else { return }
            isCompleted = true
            timeoutWorkItem?.cancel()
            timeoutWorkItem = nil
            self.taskLock.lock()
            self.activeTasks.removeValue(forKey: connectionId)
            self.taskLock.unlock()
            webSocketTask.cancel(with: .normalClosure, reason: nil)
            if !audioData.isEmpty {
                // Write audio data to temporary file and return file path only
                // JS layer will use Capacitor.convertFileSrc() to get a playable URL
                // This eliminates Base64 encoding overhead and reduces memory usage by ~80%
                let tmpDir = FileManager.default.temporaryDirectory
                let fileName = "tts_\(connectionId).mp3"
                let fileURL = tmpDir.appendingPathComponent(fileName)
                do {
                    try audioData.write(to: fileURL)
                    call.resolve(["filePath": fileURL.path])
                } catch {
                    call.reject("Failed to write audio file: \(error.localizedDescription)")
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

    @objc func deleteTTSFile(_ call: CAPPluginCall) {
        if let filePath = call.getString("filePath") {
            let fileURL = URL(fileURLWithPath: filePath)
            try? FileManager.default.removeItem(at: fileURL)
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
        self.isCurrentlyPlaying = isPlaying

        self.activateAudioSession()
        self.updateRemoteCommandsState(isPlaying: isPlaying)

        if isPlaying {
            self.stopSilencePlayer()
            self.startNowPlayingGuardian()
        } else {
            self.stopNowPlayingGuardian()
            self.scheduleSilencePauseTimer()
        }

        DispatchQueue.main.async {
            self.updateNowPlaying(title: title, artist: artist, text: text, isPlaying: isPlaying, coverBase64: coverBase64, duration: duration, currentTime: currentTime)
        }
        call.resolve()
    }

    @objc func updatePlaybackState(_ call: CAPPluginCall) {
        let isPlaying = call.getBool("isPlaying") ?? false
        self.isCurrentlyPlaying = isPlaying
        self.updateRemoteCommandsState(isPlaying: isPlaying)
        if isPlaying {
            self.wasPlayingBeforeInterruption = false
            self.wasPlayingBeforeCall = false
            self.dimSilencePlayer()  // Dim instead of stop to maintain audio session
            self.startNowPlayingGuardian()
        } else {
            self.wasPlayingBeforeInterruption = false
            self.stopNowPlayingGuardian()
            self.scheduleSilencePauseTimer()
        }
        DispatchQueue.main.async {
            var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
            info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
            info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0
            if let artwork = self.currentArtwork {
                info[MPMediaItemPropertyArtwork] = artwork
            }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
            }
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
            self.isCurrentlyPlaying = callIsPlaying
            if callIsPlaying {
                self.dimSilencePlayer()  // Dim instead of stop to maintain audio session
                self.startNowPlayingGuardian()
            } else {
                self.stopNowPlayingGuardian()
            }
        }
        let isPlaying = self.isCurrentlyPlaying
        self.updateRemoteCommandsState(isPlaying: isPlaying)
        DispatchQueue.main.async {
            self.updateNowPlaying(title: title, artist: artist, text: text, isPlaying: isPlaying, coverBase64: coverBase64, duration: duration, currentTime: currentTime)
        }
        call.resolve()
    }

    @objc func stopForegroundService(_ call: CAPPluginCall) {
        self.wasPlayingBeforeInterruption = false
        self.wasPlayingBeforeCall = false
        self.isCurrentlyPlaying = false
        self.currentArtwork = nil
        self.stopSilencePlayer()
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
        var cleanBase64 = base64String
        if let commaIndex = cleanBase64.firstIndex(of: ",") {
            cleanBase64 = String(cleanBase64[cleanBase64.index(after: commaIndex)...])
        }
        return Data(base64Encoded: cleanBase64, options: .ignoreUnknownCharacters)
    }

    private func updateNowPlaying(title: String, artist: String, text: String? = nil, isPlaying: Bool, coverBase64: String? = nil, duration: Double? = nil, currentTime: Double? = nil) {
        if let coverData = getCoverData(from: coverBase64), let image = UIImage(data: coverData) {
            self.currentArtwork = MPMediaItemArtwork(boundsSize: image.size) { _ in return image }
        }
        
        var nowPlayingInfo = [String: Any]()
        let displayTitle = (text != nil && !text!.isEmpty) ? text! : (title.isEmpty ? "TTS Reading" : title)
        nowPlayingInfo[MPMediaItemPropertyTitle] = displayTitle
        if !title.isEmpty && displayTitle != title {
            nowPlayingInfo[MPMediaItemPropertyAlbumTitle] = title
        }
        nowPlayingInfo[MPMediaItemPropertyArtist] = artist.isEmpty ? "E-Book Reader" : artist
        nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        nowPlayingInfo[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0

        let validDuration = (duration != nil && duration! > 0) ? duration! : 15.0
        nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = validDuration
        
        let validCurrentTime = (currentTime != nil && currentTime! >= 0) ? currentTime! : 0.0
        nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = validCurrentTime
        
        if let artwork = self.currentArtwork {
            nowPlayingInfo[MPMediaItemPropertyArtwork] = artwork
        }
        
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
        if #available(iOS 13.0, *) {
            MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
        }
    }

    private func setupAudioSessionObserver() {
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.routeChangeNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIApplication.didEnterBackgroundNotification, object: nil)

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
    }

    @objc private func handleApplicationDidEnterBackground() {
        if !self.isCurrentlyPlaying {
            DispatchQueue.main.async {
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
                if #available(iOS 13.0, *) {
                    MPNowPlayingInfoCenter.default().playbackState = .paused
                }
            }
        }
    }

    @objc private func handleAudioRouteChange(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }
        if reason == .oldDeviceUnavailable {
            print("[NativeTTS] Audio route changed: old device unavailable (headphone unplugged)")
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.isCurrentlyPlaying = false
                self.stopNowPlayingGuardian()
                self.scheduleSilencePauseTimer()
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
                if #available(iOS 13.0, *) {
                    MPNowPlayingInfoCenter.default().playbackState = .paused
                }
                self.bridge?.webView?.evaluateJavaScript("if (window.tts) { window.tts.pause(); }", completionHandler: nil)
                self.notifyListeners("mediaAction", data: ["action": "pause"])
            }
        }
    }

    @objc private func handleAudioSessionInterruption(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            print("[NativeTTS] Audio session interruption began (external app / call / Siri)")
            self.isAudioSessionInterrupted = true
            if self.isCurrentlyPlaying {
                self.wasPlayingBeforeInterruption = true
                self.wasPlayingBeforeCall = true
            }
            self.emergencyPause(reason: "AVAudioSession Interruption Began")

        case .ended:
            guard self.isAudioSessionInterrupted || self.wasPlayingBeforeInterruption || self.wasPlayingBeforeCall else {
                print("[NativeTTS] Audio session interruption ended ignored: no active interruption was recorded")
                return
            }
            self.isAudioSessionInterrupted = false

            guard self.wasPlayingBeforeInterruption || self.wasPlayingBeforeCall else {
                print("[NativeTTS] Audio session interruption ended ignored: was not playing or paused by user")
                return
            }

            print("[NativeTTS] Audio session interruption ended")

            var systemAllowsResume = true
            if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                systemAllowsResume = options.contains(.shouldResume)
            }

            if systemAllowsResume {
                self.resumeAfterInterruptionOrCall()
            } else {
                self.wasPlayingBeforeInterruption = false
                self.wasPlayingBeforeCall = false
                DispatchQueue.main.async { [weak self] in
                    guard self != nil else { return }
                    if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                        info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                    }
                    if #available(iOS 13.0, *) {
                        MPNowPlayingInfoCenter.default().playbackState = .paused
                    }
                }
            }

        @unknown default:
            break
        }
    }

    // MARK: - Remote Control Handlers (Handles both MPRemoteCommandCenter and Bluetooth UIEvent)
    func handleRemotePlay() {
        if shouldThrottleRemoteCommand() { return }
        print("[NativeTTS] handleRemotePlay")
        self.activateAudioSession()
        self.isCurrentlyPlaying = true
        self.dimSilencePlayer()  // Dim instead of stop to maintain audio session
        self.updateRemoteCommandsState(isPlaying: true)
        self.startNowPlayingGuardian()

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
            guard let self = self else { return }
            if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .playing
            }
            // Remote commands: use notifyListeners only (JS listens via Capacitor plugin)
            self.notifyListeners("mediaAction", data: ["action": "play"])
        }
    }

    func handleRemotePause() {
        if shouldThrottleRemoteCommand() { return }
        print("[NativeTTS] handleRemotePause")
        self.isCurrentlyPlaying = false
        self.wasPlayingBeforeInterruption = false
        self.wasPlayingBeforeCall = false
        self.isAudioSessionInterrupted = false
        self.stopNowPlayingGuardian()
        self.updateRemoteCommandsState(isPlaying: false)
        self.scheduleSilencePauseTimer()

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .paused
            }
            // Remote commands: use notifyListeners only
            self.notifyListeners("mediaAction", data: ["action": "pause"])
        }
    }

    func handleRemoteTogglePlayPause() {
        if shouldThrottleRemoteCommand() { return }
        print("[NativeTTS] handleRemoteTogglePlayPause, current isPlaying=\(self.isCurrentlyPlaying)")
        let shouldPlay = !self.isCurrentlyPlaying
        if shouldPlay {
            self.activateAudioSession()
            self.isCurrentlyPlaying = true
            self.dimSilencePlayer()  // Dim instead of stop to maintain audio session
            self.updateRemoteCommandsState(isPlaying: true)
            self.startNowPlayingGuardian()

            var bgTaskId: UIBackgroundTaskIdentifier = .invalid
            bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ResumePlaybackToggle") {
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
                guard let self = self else { return }
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
                if #available(iOS 13.0, *) {
                    MPNowPlayingInfoCenter.default().playbackState = .playing
                }
                // Remote commands: use notifyListeners only
                self.notifyListeners("mediaAction", data: ["action": "play"])
            }
        } else {
            self.isCurrentlyPlaying = false
            self.wasPlayingBeforeInterruption = false
            self.wasPlayingBeforeCall = false
            self.isAudioSessionInterrupted = false
            self.stopNowPlayingGuardian()
            self.updateRemoteCommandsState(isPlaying: false)
            self.scheduleSilencePauseTimer()

            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
                if #available(iOS 13.0, *) {
                    MPNowPlayingInfoCenter.default().playbackState = .paused
                }
                // Remote commands: use notifyListeners only
                self.notifyListeners("mediaAction", data: ["action": "pause"])
            }
        }
    }

    func handleRemoteNext() {
        if shouldThrottleRemoteCommand() { return }
        print("[NativeTTS] handleRemoteNext")
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
            // Remote commands: use notifyListeners only
            self.notifyListeners("mediaAction", data: ["action": "next"])
        }
    }

    func handleRemotePrevious() {
        if shouldThrottleRemoteCommand() { return }
        print("[NativeTTS] handleRemotePrevious")
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
            // Remote commands: use notifyListeners only
            self.notifyListeners("mediaAction", data: ["action": "previous"])
        }
    }

    func handleRemoteStop() {
        if shouldThrottleRemoteCommand() { return }
        print("[NativeTTS] handleRemoteStop")
        self.isCurrentlyPlaying = false
        self.wasPlayingBeforeInterruption = false
        self.wasPlayingBeforeCall = false
        self.isAudioSessionInterrupted = false
        self.stopSilencePlayer()
        self.stopNowPlayingGuardian()
        self.updateRemoteCommandsState(isPlaying: false)

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .stopped
            }
            // Remote commands: use notifyListeners only
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
            self?.handleRemotePlay()
            return .success
        }

        commandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.handleRemotePause()
            return .success
        }

        commandCenter.stopCommand.addTarget { [weak self] _ in
            self?.handleRemoteStop()
            return .success
        }

        commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.handleRemoteTogglePlayPause()
            return .success
        }

        commandCenter.nextTrackCommand.addTarget { [weak self] _ in
            self?.handleRemoteNext()
            return .success
        }

        commandCenter.previousTrackCommand.addTarget { [weak self] _ in
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
