const fs = require('fs');
const crypto = require('crypto');

function connectId() {
  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/[x]/g, () => {
    return (Math.random() * 16 | 0).toString(16);
  });
}

function dateToString() {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = new Date();
  const dayName = days[d.getUTCDay()];
  const monthName = months[d.getUTCMonth()];
  const date = d.getUTCDate().toString().padStart(2, '0');
  const year = d.getUTCFullYear();
  const hours = d.getUTCHours().toString().padStart(2, '0');
  const minutes = d.getUTCMinutes().toString().padStart(2, '0');
  const seconds = d.getUTCSeconds().toString().padStart(2, '0');
  return `${dayName} ${monthName} ${date} ${year} ${hours}:${minutes}:${seconds} GMT+0000 (Coordinated Universal Time)`;
}

function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

let clockSkew = 0;

async function syncClock() {
  console.log("Syncing clock with server...");
  try {
    const response = await fetch("https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4");
    const serverDate = response.headers.get("Date");
    if (serverDate) {
      const serverTime = new Date(serverDate).getTime();
      const localTime = Date.now();
      clockSkew = serverTime - localTime;
      console.log(`Clock synced! Skew is: ${clockSkew} ms`);
    } else {
      console.log("No Date header received. Using system time.");
    }
  } catch (e) {
    console.error("Failed to sync clock:", e);
  }
}

function generateSecMsGecToken() {
  const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const WIN_EPOCH = 11644473600;
  
  let unixSeconds = Math.floor((Date.now() + clockSkew) / 1000);
  unixSeconds += WIN_EPOCH;
  unixSeconds -= (unixSeconds % 300);
  
  const ticks = BigInt(unixSeconds) * 10000000n;
  const strToHash = ticks.toString() + TRUSTED_CLIENT_TOKEN;
  
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

async function runTest() {
  await syncClock();
  console.log("Generating Sec-MS-GEC Token...");
  const secMsGec = generateSecMsGecToken();
  console.log("Token:", secMsGec);
  
  const connectionId = connectId();
  const voice = "zh-CN-XiaoxiaoNeural";
  const text = "您好！這是微軟 Edge 流式語音合成測試。聽起來是不是非常流暢且毫無延遲呢？";
  
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
              `?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4` +
              `&ConnectionId=${connectionId}` +
              `&Sec-MS-GEC=${secMsGec}` +
              `&Sec-MS-GEC-Version=1-143.0.3650.75`;
              
  console.log("Connecting to WebSocket:", url);
  
  const WebSocket = require('ws');
  const ws = new WebSocket(url, {
    headers: {
      "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
    }
  });
  
  const audioChunks = [];
  let metadataCount = 0;
  
  ws.onopen = () => {
    console.log("WebSocket connection opened. Sending config...");
    
    const configMsg = 
      `X-Timestamp:${dateToString()}\r\n` +
      `Content-Type:application/json; charset=utf-8\r\n` +
      `Path:speech.config\r\n\r\n` +
      JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: "true",
                wordBoundaryEnabled: "false"
              },
              outputFormat: "audio-24khz-48kbitrate-mono-mp3"
            }
          }
        }
      });
    ws.send(configMsg);
    
    console.log("Sending SSML request...");
    const escapedText = escapeXml(text);
    const ssml = 
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
      `<voice name='${voice}'>` +
      `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>` +
      `${escapedText}` +
      `</prosody>` +
      `</voice>` +
      `</speak>`;
      
    const ssmlMsg = 
      `X-RequestId:${connectId()}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${dateToString()}Z\r\n` +
      `Path:ssml\r\n\r\n` +
      ssml;
    ws.send(ssmlMsg);
  };
  
  ws.onmessage = async (event) => {
    if (typeof event.data === "string") {
      const separator = "\r\n\r\n";
      const index = event.data.indexOf(separator);
      if (index !== -1) {
        const headersStr = event.data.substring(0, index);
        const bodyStr = event.data.substring(index + separator.length);
        const headers = {};
        headersStr.split("\r\n").forEach(line => {
          const parts = line.split(":");
          if (parts.length >= 2) {
            headers[parts[0].trim()] = parts.slice(1).join(":").trim();
          }
        });
        
        const path = headers["Path"];
        if (path === "audio.metadata") {
          metadataCount++;
          console.log(`Received Metadata event ${metadataCount}`);
        } else if (path === "turn.end") {
          console.log("Received turn.end. Closing connection...");
          ws.close();
        }
      }
    } else {
      const buffer = event.data;
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      const view = new DataView(arrayBuffer);
      if (arrayBuffer.byteLength < 2) return;
      const headerLength = view.getUint16(0, false);
      if (headerLength + 2 > arrayBuffer.byteLength) return;
      
      const headerBytes = new Uint8Array(arrayBuffer, 2, headerLength - 2);
      const textDecoder = new TextDecoder("utf-8");
      const headersStr = textDecoder.decode(headerBytes);
      const headers = {};
      headersStr.split("\r\n").forEach(line => {
        const parts = line.split(":");
        if (parts.length >= 2) {
          headers[parts[0].trim()] = parts.slice(1).join(":").trim();
        }
      });
      
      if (headers["Path"] === "audio") {
        const audioBytes = new Uint8Array(arrayBuffer, headerLength + 2);
        audioChunks.push(Buffer.from(audioBytes));
      }
    }
  };
  
  ws.onclose = () => {
    console.log("WebSocket connection closed.");
    if (audioChunks.length > 0) {
      const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      console.log(`Successfully received ${audioChunks.length} audio chunks, total size: ${totalLength} bytes.`);
      console.log(`Received ${metadataCount} metadata events.`);
      
      const combined = Buffer.concat(audioChunks);
      fs.writeFileSync('/Users/burnfan/Documents/antigravity/mysterious-oppenheimer/scratch/test_voice.mp3', combined);
      console.log("Saved audio to scratch/test_voice.mp3");
      console.log("TEST SUCCESSFUL!");
    } else {
      console.error("Test failed: No audio chunks received.");
    }
  };
  
  ws.onerror = (err) => {
    console.error("WebSocket Error:", err);
  };
}

runTest();
