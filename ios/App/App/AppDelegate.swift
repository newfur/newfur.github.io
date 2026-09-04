import UIKit
import Capacitor
import AVFoundation
import MediaPlayer

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        application.beginReceivingRemoteControlEvents()
        // Configure audio session for background TTS playback
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try audioSession.setActive(true)
        } catch {
            print("Failed to configure AVAudioSession: \(error)")
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
                    if let vc = (self.window?.rootViewController as? ViewController) ?? (app.windows.first?.rootViewController as? ViewController) {
                        vc.webView?.evaluateJavaScript(cmd, completionHandler: nil)
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
public class NativeTTS: CAPPlugin, CAPBridgedPlugin {
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
        CAPPluginMethod(name: "copyFileToDownloads", returnType: CAPPluginReturnPromise)
    ]

    private var activeTasks = [String: URLSessionWebSocketTask]()
    private let taskLock = NSLock()
    private var currentArtwork: MPMediaItemArtwork?
    private var wasPlayingBeforeInterruption: Bool = false
    private var isAudioSessionInterrupted: Bool = false
    private var isCurrentlyPlaying: Bool = false
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
        setupRemoteCommands()
        setupAudioSessionObserver()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
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
                // Write audio data to a temporary file instead of Base64 encoding
                // This avoids the overhead of Base64 encode/decode and large string transfer through Capacitor bridge
                let tmpDir = FileManager.default.temporaryDirectory
                let fileName = "tts_\(connectionId).mp3"
                let fileURL = tmpDir.appendingPathComponent(fileName)
                do {
                    try audioData.write(to: fileURL)
                    call.resolve(["filePath": fileURL.path])
                } catch {
                    // Fallback to Base64 if file write fails
                    let base64 = audioData.base64EncodedString()
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
        self.isCurrentlyPlaying = isPlaying

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            print("[NativeTTS] Failed to activate AVAudioSession on startForegroundService: \(error)")
        }

        DispatchQueue.main.async {
            self.updateNowPlaying(title: title, artist: artist, text: text, isPlaying: isPlaying, coverBase64: coverBase64)
        }
        call.resolve()
    }

    @objc func updatePlaybackState(_ call: CAPPluginCall) {
        let isPlaying = call.getBool("isPlaying") ?? false
        self.isCurrentlyPlaying = isPlaying
        if !isPlaying {
            self.wasPlayingBeforeInterruption = false
        }
        DispatchQueue.main.async {
            if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
                if let artwork = self.currentArtwork {
                    info[MPMediaItemPropertyArtwork] = artwork
                }
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
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
        // 不再從 JS payload 讀取 isPlaying，而是使用原生端的 isCurrentlyPlaying 作為唯一真相。
        // 這避免了句子切換（每 3-10 秒觸發一次 _updateMediaSession）的異步回調
        // 覆蓋由 updatePlaybackState / Remote Command 設置的權威播放狀態。
        let isPlaying = self.isCurrentlyPlaying
        DispatchQueue.main.async {
            self.updateNowPlaying(title: title, artist: artist, text: text, isPlaying: isPlaying, coverBase64: coverBase64)
        }
        call.resolve()
    }

    @objc func stopForegroundService(_ call: CAPPluginCall) {
        self.wasPlayingBeforeInterruption = false
        self.isCurrentlyPlaying = false
        self.currentArtwork = nil
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

    private func updateNowPlaying(title: String, artist: String, text: String? = nil, isPlaying: Bool, coverBase64: String? = nil) {
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
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
                if #available(iOS 13.0, *) {
                    MPNowPlayingInfoCenter.default().playbackState = .paused
                }
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
            // 檢查是否為系統後台掛起/鎖屏喚醒造成的通知 (wasSuspended == true)
            // iOS 在鎖屏掛起及解鎖恢復時會派發此通知，這不是外部 App（如電話、Siri）的真實打斷。
            // 切勿向前端發送 pause / play，否則解鎖進入前台時會導致原生端與前端狀態衝突，造成雙重音訊並發！
            if let wasSuspended = userInfo[AVAudioSessionInterruptionWasSuspendedKey] as? Bool, wasSuspended {
                print("[NativeTTS] Audio session interruption began was due to system suspension, ignoring pause")
                return
            }

            print("[NativeTTS] Audio session interruption began (other app playing sound)")
            self.isAudioSessionInterrupted = true
            self.wasPlayingBeforeInterruption = self.isCurrentlyPlaying
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.isCurrentlyPlaying = false
                self.notifyListeners("mediaAction", data: ["action": "pause"])
                if #available(iOS 13.0, *) {
                    MPNowPlayingInfoCenter.default().playbackState = .paused
                }
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
            }

        case .ended:
            // 只有此前確實記錄了真實外部中斷（如電話、Siri），才允許處理恢復
            guard self.isAudioSessionInterrupted else {
                print("[NativeTTS] Audio session interruption ended ignored: no active interruption was recorded")
                return
            }
            self.isAudioSessionInterrupted = false

            // 如果此前未在播放，或者用戶已在鎖屏/控制中心手動暫停，絕不自動恢復播放
            guard self.wasPlayingBeforeInterruption else {
                print("[NativeTTS] Audio session interruption ended ignored: was not playing or paused by user")
                return
            }
            self.wasPlayingBeforeInterruption = false

            print("[NativeTTS] Audio session interruption ended (other app stopped)")

            var systemAllowsResume = true
            if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                systemAllowsResume = options.contains(.shouldResume)
            }

            if systemAllowsResume {
                do {
                    let session = AVAudioSession.sharedInstance()
                    try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
                    try session.setActive(true)
                } catch {
                    print("[NativeTTS] Failed to reactivate AVAudioSession: \(error)")
                }
            }

            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }

                if systemAllowsResume {
                    self.isCurrentlyPlaying = true
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
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                        self.notifyListeners("mediaAction", data: ["action": "play"])
                    }
                } else {
                    if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                        info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                        if let artwork = self.currentArtwork {
                            info[MPMediaItemPropertyArtwork] = artwork
                        }
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

    private func setupRemoteCommands() {
        let commandCenter = MPRemoteCommandCenter.shared()
        commandCenter.playCommand.removeTarget(nil)
        commandCenter.pauseCommand.removeTarget(nil)
        commandCenter.stopCommand.removeTarget(nil)
        commandCenter.togglePlayPauseCommand.removeTarget(nil)
        commandCenter.nextTrackCommand.removeTarget(nil)
        commandCenter.previousTrackCommand.removeTarget(nil)

        commandCenter.playCommand.isEnabled = true
        commandCenter.pauseCommand.isEnabled = true
        commandCenter.stopCommand.isEnabled = true
        commandCenter.togglePlayPauseCommand.isEnabled = true
        commandCenter.nextTrackCommand.isEnabled = true
        commandCenter.previousTrackCommand.isEnabled = true

        commandCenter.playCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            print("[NativeTTS] RemoteCommand: play")

            // 重新激活音频会话，防止在后台暂停超过 10 秒后会话被 iOS 系统释放
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
                try session.setActive(true)
            } catch {
                print("[NativeTTS] Failed to reactivate AVAudioSession on playCommand: \(error)")
            }

            // 申请后台执行任务，防止 WKWebView 从深度冻结恢复时在音频输出前被系统再次挂起
            var bgTaskId: UIBackgroundTaskIdentifier = .invalid
            bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ResumePlayback") {
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

            DispatchQueue.main.async {
                self.isCurrentlyPlaying = true
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
                if #available(iOS 13.0, *) {
                    MPNowPlayingInfoCenter.default().playbackState = .playing
                }
                self.bridge?.webView?.evaluateJavaScript("", completionHandler: nil) // 空執行以喚醒 WKWebView 進程
                self.notifyListeners("mediaAction", data: ["action": "play"])
            }
            return .success
        }

        commandCenter.pauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            print("[NativeTTS] RemoteCommand: pause")
            self.isCurrentlyPlaying = false
            self.wasPlayingBeforeInterruption = false
            self.isAudioSessionInterrupted = false
            DispatchQueue.main.async {
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
                if #available(iOS 13.0, *) {
                    MPNowPlayingInfoCenter.default().playbackState = .paused
                }
                self.notifyListeners("mediaAction", data: ["action": "pause"])
            }
            return .success
        }

        commandCenter.stopCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            print("[NativeTTS] RemoteCommand: stop")
            self.isCurrentlyPlaying = false
            self.wasPlayingBeforeInterruption = false
            self.isAudioSessionInterrupted = false
            DispatchQueue.main.async {
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
                if #available(iOS 13.0, *) {
                    MPNowPlayingInfoCenter.default().playbackState = .stopped
                }
                self.notifyListeners("mediaAction", data: ["action": "stop"])
            }
            return .success
        }

        commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            print("[NativeTTS] RemoteCommand: togglePlayPause")
            let shouldPlay = !self.isCurrentlyPlaying

            if shouldPlay {
                do {
                    let session = AVAudioSession.sharedInstance()
                    try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
                    try session.setActive(true)
                } catch {
                    print("[NativeTTS] Failed to reactivate AVAudioSession on toggle: \(error)")
                }

                var bgTaskId: UIBackgroundTaskIdentifier = .invalid
                bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ResumePlaybackToggle") {
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
            } else {
                self.wasPlayingBeforeInterruption = false
                self.isAudioSessionInterrupted = false
            }

            DispatchQueue.main.async {
                self.isCurrentlyPlaying = shouldPlay
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPNowPlayingInfoPropertyPlaybackRate] = shouldPlay ? 1.0 : 0.0
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
                if #available(iOS 13.0, *) {
                    MPNowPlayingInfoCenter.default().playbackState = shouldPlay ? .playing : .paused
                }
                self.notifyListeners("mediaAction", data: ["action": shouldPlay ? "play" : "pause"])
            }
            return .success
        }

        commandCenter.nextTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            print("[NativeTTS] RemoteCommand: next")
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
            DispatchQueue.main.async {
                self.notifyListeners("mediaAction", data: ["action": "next"])
            }
            return .success
        }

        commandCenter.previousTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            print("[NativeTTS] RemoteCommand: previous")
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
            DispatchQueue.main.async {
                self.notifyListeners("mediaAction", data: ["action": "previous"])
            }
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
