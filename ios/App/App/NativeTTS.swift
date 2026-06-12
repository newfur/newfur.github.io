import Foundation
import Capacitor

@objc(NativeTTS)
public class NativeTTS: CAPPlugin {
    
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
        
        let urlString = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=\(connectionId)&Sec-MS-GEC=\(secMsGec)&Sec-MS-GEC-Version=1-143.0.3650.75"
        
        guard let url = URL(string: urlString) else {
            call.reject("Invalid URL")
            return
        }
        
        var request = URLRequest(url: url)
        request.setValue("chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold", forHTTPHeaderField: "Origin")
        request.setValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0", forHTTPHeaderField: "User-Agent")
        
        let session = URLSession(configuration: .default)
        var webSocketTask: URLSessionWebSocketTask? = session.webSocketTask(with: request)
        
        var audioData = Data()
        var hasFinished = false
        
        func receiveMessage() {
            webSocketTask?.receive { [weak self] result in
                guard let self = self else { return }
                if hasFinished { return }
                switch result {
                case .failure(let error):
                    hasFinished = true
                    call.reject("WebSocket read error: \(error.localizedDescription)")
                    webSocketTask = nil
                case .success(let message):
                    switch message {
                    case .string(let textString):
                        if textString.contains("Path:turn.end") {
                            hasFinished = true
                            webSocketTask?.cancel(with: .normalClosure, reason: nil)
                            webSocketTask = nil
                            
                            if audioData.count > 0 {
                                let base64 = audioData.base64EncodedString()
                                call.resolve([
                                    "audioBase64": base64
                                ])
                            } else {
                                call.reject("No audio data received")
                            }
                            return
                        }
                    case .data(let data):
                        if data.count >= 2 {
                            let headerLength = (Int(data[0]) << 8) | Int(data[1])
                            if headerLength + 2 <= data.count {
                                let headerBytes = data.subdata(in: 2..<(headerLength + 2))
                                if let headers = String(data: headerBytes, encoding: .utf8) {
                                    if headers.contains("Path:audio") {
                                        let audioBytes = data.subdata(in: (headerLength + 2)..<data.count)
                                        audioData.append(audioBytes)
                                    }
                                }
                            }
                        }
                    @unknown default:
                        break
                    }
                    receiveMessage()
                }
            }
        }
        
        webSocketTask?.resume()
        receiveMessage()
        
        // Send config message
        let configMsg = "X-Timestamp:\(dateStr)\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}"
        
        webSocketTask?.send(.string(configMsg)) { error in
            if let error = error {
                if !hasFinished {
                    hasFinished = true
                    call.reject("Failed to send config: \(error.localizedDescription)")
                    webSocketTask?.cancel()
                    webSocketTask = nil
                }
            }
        }
        
        // Send SSML message
        let escapedText = escapeXml(unsafe: text)
        let ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='\(voice)'><prosody pitch='+0Hz' rate='\(rate)' volume='\(volume)'>\(escapedText)</prosody></voice></speak>"
        
        let ssmlMsg = "X-RequestId:\(connectionId)\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:\(dateStr)Z\r\nPath:ssml\r\n\r\n\(ssml)"
        
        webSocketTask?.send(.string(ssmlMsg)) { error in
            if let error = error {
                if !hasFinished {
                    hasFinished = true
                    call.reject("Failed to send SSML: \(error.localizedDescription)")
                    webSocketTask?.cancel()
                    webSocketTask = nil
                }
            }
        }
    }
    
    private func escapeXml(unsafe: String) -> String {
        return unsafe.replacingOccurrences(of: "&", with: "&amp;")
                     .replacingOccurrences(of: "<", with: "&lt;")
                     .replacingOccurrences(of: ">", with: "&gt;")
                     .replacingOccurrences(of: "\"", with: "&quot;")
                     .replacingOccurrences(of: "'", with: "&apos;")
    }
}
