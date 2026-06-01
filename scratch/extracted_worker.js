
  // Helper: decode base32
  function decodeBase32(str) {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let val = 0;
    for (let i = 0; i < str.length; i++) {
      const code = chars.indexOf(str[i].toUpperCase());
      if (code === -1) return -1;
      val = val * 32 + code;
    }
    return val;
  }

  // Helper: get numeric value
  function getNumericValue(uint8Array) {
    if (!uint8Array || uint8Array.length === 0) return -1;
    let isAsciiNumber = true;
    for (let i = 0; i < uint8Array.length; i++) {
      const byte = uint8Array[i];
      if ((byte < 0x30 || byte > 0x39) && byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
        isAsciiNumber = false;
        break;
      }
    }
    if (isAsciiNumber) {
      const decoder = new TextDecoder('utf-8');
      const str = decoder.decode(uint8Array).trim();
      if (str.length > 0) {
        const parsed = parseInt(str, 10);
        if (!isNaN(parsed)) return parsed;
      }
    }
    let val = 0;
    for (let i = 0; i < uint8Array.length; i++) {
      val = val * 256 + uint8Array[i];
    }
    return val;
  }

  // LZ77 decompression
  function decompressPalmDoc(data) {
    const output = [];
    let i = 0;
    const len = data.length;
    while (i < len) {
      const b = data[i++];
      if (b === 0) {
        output.push(0);
      } else if (b <= 8) {
        for (let j = 0; j < b && i < len; j++) {
          output.push(data[i++]);
        }
      } else if (b <= 0x7f) {
        output.push(b);
      } else if (b <= 0xbf) {
        if (i >= len) break;
        const b2 = data[i++];
        const pair = ((b << 8) | b2) & 0x3fff;
        const distance = pair >> 3;
        const length = (pair & 0x07) + 3;
        const outLen = output.length;
        for (let j = 0; j < length; j++) {
          const srcIdx = outLen - distance + j;
          if (srcIdx >= 0 && srcIdx < output.length) {
            output.push(output[srcIdx]);
          } else {
            output.push(32);
          }
        }
      } else {
        output.push(32);
        output.push(b ^ 0x80);
      }
    }
    return new Uint8Array(output);
  }

  // Trailing data size
  function getTrailingBytesSize(ptr, size, extraDataFlags) {
    if (!extraDataFlags) return 0;
    let num = 0;
    let f = extraDataFlags >> 1;
    while (f > 0) {
      if (f & 1) {
        num += getSizeOfTrailingDataEntry(ptr, size - num);
      }
      f >>= 1;
    }
    if (extraDataFlags & 1) {
      if (size - num > 0) {
        const lastByte = ptr[size - num - 1];
        num += (lastByte & 3) + 1;
      }
    }
    return num;
  }

  function getSizeOfTrailingDataEntry(ptr, size) {
    let bitpos = 0;
    let result = 0;
    if (size <= 0) return result;
    while (true) {
      const v = ptr[size - 1];
      result |= (v & 0x7F) << bitpos;
      bitpos += 7;
      size -= 1;
      if ((v & 0x80) !== 0 || bitpos >= 28 || size === 0) {
        return result;
      }
    }
  }

  self.onmessage = function(e) {
    const { arrayBuffer, titleFallback } = e.data;
    const view = new DataView(arrayBuffer);
    const records = [];
    const numRecords = view.getUint16(76);
    
    for (let i = 0; i < numRecords; i++) {
      const offset = view.getUint32(78 + i * 8);
      const attributes = view.getUint8(78 + i * 8 + 4);
      const uniqueId = view.getUint32(78 + i * 8 + 4) & 0x00FFFFFF;
      records.push({ offset, attributes, uniqueId });
    }

    function getRecordData(index) {
      const start = records[index].offset;
      const end = (index + 1 < records.length) ? records[index + 1].offset : arrayBuffer.byteLength;
      return new Uint8Array(arrayBuffer, start, end - start);
    }

    // Parse Record 0
    let compression = 0;
    let textRecordCount = 0;
    let mobiHeaderOffset = 16;
    let firstResourceRecordIndex = -1;
    let extraDataFlags = 0;

    if (records.length > 0) {
      const data0 = getRecordData(0);
      const view0 = new DataView(data0.buffer, data0.byteOffset, data0.byteLength);
      compression = view0.getUint16(0);
      textRecordCount = view0.getUint16(8);

      let mobiOffset = -1;
      for (let i = 0; i < data0.length - 4; i++) {
        if (data0[i] === 0x4D && data0[i+1] === 0x4F && data0[i+2] === 0x42 && data0[i+3] === 0x49) {
          mobiOffset = i;
          break;
        }
      }
      mobiHeaderOffset = mobiOffset !== -1 ? mobiOffset : 16;
      if (mobiOffset !== -1 && data0.length >= mobiHeaderOffset + 92 + 4) {
        firstResourceRecordIndex = view0.getUint32(mobiHeaderOffset + 92);
      }
      if (data0.length >= mobiHeaderOffset + 16) {
        const headerLength = view0.getUint32(mobiHeaderOffset + 4);
        const mobiVersion = view0.getUint32(mobiHeaderOffset + 12);
        if (headerLength >= 228 && mobiVersion >= 5 && data0.length >= mobiHeaderOffset + 228) {
          extraDataFlags = view0.getUint16(mobiHeaderOffset + 226);
        }
      }
    }

    // EXTH metadata
    let author = 'Unknown Author';
    let title = titleFallback;
    let coverRecordIndex = -1;
    let thumbnailRecordIndex = -1;

    try {
      const data0 = getRecordData(0);
      const view0 = new DataView(data0.buffer, data0.byteOffset, data0.byteLength);
      const mobiHeaderLength = view0.getUint32(mobiHeaderOffset + 4);
      const exthOffset = mobiHeaderOffset + mobiHeaderLength;
      
      if (exthOffset + 12 <= data0.length) {
        const exthIdentifier = String.fromCharCode(data0[exthOffset], data0[exthOffset+1], data0[exthOffset+2], data0[exthOffset+3]);
        if (exthIdentifier === 'EXTH') {
          const exthLength = view0.getUint32(exthOffset + 4);
          const numItems = view0.getUint32(exthOffset + 8);
          let offset = exthOffset + 12;
          const decoder = new TextDecoder('utf-8');
          for (let i = 0; i < numItems; i++) {
            if (offset + 8 > data0.length) break;
            const type = view0.getUint32(offset);
            const length = view0.getUint32(offset + 4);
            if (offset + length > data0.length) break;
            const valData = data0.subarray(offset + 8, offset + length);
            if (type === 100) {
              author = decoder.decode(valData).trim();
            } else if (type === 201) {
              coverRecordIndex = getNumericValue(valData);
            } else if (type === 202) {
              thumbnailRecordIndex = getNumericValue(valData);
            } else if (type === 105) {
              if (!author) author = decoder.decode(valData).trim();
            } else if (type === 503) {
              title = decoder.decode(valData).trim();
            }
            offset += length;
          }
        }
      }
    } catch (e) {
      console.warn("Failed parsing EXTH inside worker", e);
    }

    // PalmDoc Decompress Text
    let fullHtml = '';
    const flowUrlsData = {};

    if (compression === 2 || compression === 1) {
      const textRecords = [];
      for (let i = 1; i <= textRecordCount && i < records.length; i++) {
        const recordData = getRecordData(i);
        const trailingSize = getTrailingBytesSize(recordData, recordData.length, extraDataFlags);
        const cleanRecordData = trailingSize > 0 ? recordData.subarray(0, recordData.length - trailingSize) : recordData;
        const decompressed = compression === 2 ? decompressPalmDoc(cleanRecordData) : cleanRecordData;
        textRecords.push(decompressed);
      }
      
      const totalLength = textRecords.reduce((acc, buf) => acc + buf.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const buf of textRecords) {
        combined.set(buf, offset);
        offset += buf.length;
      }

      // Find FDST
      let fdstRecordIndex = -1;
      for (let i = 1; i < records.length; i++) {
        try {
          const data = getRecordData(i);
          if (data.length >= 4 && String.fromCharCode(data[0], data[1], data[2], data[3]) === 'FDST') {
            fdstRecordIndex = i;
            break;
          }
        } catch(e) {}
      }

      const decoder = new TextDecoder('utf-8');
      if (fdstRecordIndex !== -1) {
        try {
          const fdstData = getRecordData(fdstRecordIndex);
          const fdstDv = new DataView(fdstData.buffer, fdstData.byteOffset, fdstData.byteLength);
          const numFlows = fdstDv.getUint32(8);
          const flows = [];
          for (let i = 0; i < numFlows; i++) {
            const start = fdstDv.getUint32(12 + i * 8);
            const end = fdstDv.getUint32(12 + i * 8 + 4);
            flows.push({ start, end });
          }

          if (flows.length > 0) {
            const htmlBytes = combined.subarray(flows[0].start, Math.min(combined.length, flows[0].end));
            fullHtml = decoder.decode(htmlBytes);
          } else {
            fullHtml = decoder.decode(combined);
          }

          for (let i = 1; i < flows.length; i++) {
            const flowStart = flows[i].start;
            const flowEnd = Math.min(combined.length, flows[i].end);
            if (flowStart < combined.length) {
              const flowBytes = combined.subarray(flowStart, flowEnd);
              const flowText = decoder.decode(flowBytes);
              flowUrlsData[i] = { text: flowText, type: 'text/css' };
            }
          }
        } catch (e) {
          fullHtml = decoder.decode(combined);
        }
      } else {
        fullHtml = decoder.decode(combined);
      }
    } else {
      fullHtml = 'DRM/HUFF Compressed Book';
    }

    // Extract Cover Record
    let coverRecordBytes = null;
    let coverMime = 'image/jpeg';
    const candidates = [];
    let firstImageRecord = -1;
    let firstNonBook = -1;

    try {
      const data0 = getRecordData(0);
      const view0 = new DataView(data0.buffer, data0.byteOffset, data0.byteLength);
      const offsetFirstImage = mobiHeaderOffset + 92;
      const offsetFirstNonBook = mobiHeaderOffset + 64;
      if (data0.length >= offsetFirstImage + 4) {
        firstImageRecord = view0.getUint32(offsetFirstImage);
      }
      if (data0.length >= offsetFirstNonBook + 4) {
        firstNonBook = view0.getUint32(offsetFirstNonBook);
      }
    } catch(e) {}

    if (coverRecordIndex !== -1 && coverRecordIndex !== 0xffffffff && coverRecordIndex !== 4294967295) {
      if (firstImageRecord !== -1 && firstImageRecord !== 0xffffffff && firstImageRecord !== 4294967295) candidates.push(firstImageRecord + coverRecordIndex);
      if (firstNonBook !== -1 && firstNonBook !== 0xffffffff && firstNonBook !== 4294967295) candidates.push(firstNonBook + coverRecordIndex);
      if (textRecordCount !== undefined) candidates.push(textRecordCount + 1 + coverRecordIndex);
      candidates.push(coverRecordIndex);
    }
    if (thumbnailRecordIndex !== -1 && thumbnailRecordIndex !== 0xffffffff && thumbnailRecordIndex !== 4294967295) {
      if (firstImageRecord !== -1 && firstImageRecord !== 0xffffffff && firstImageRecord !== 4294967295) candidates.push(firstImageRecord + thumbnailRecordIndex);
      if (firstNonBook !== -1 && firstNonBook !== 0xffffffff && firstNonBook !== 4294967295) candidates.push(firstNonBook + thumbnailRecordIndex);
      if (textRecordCount !== undefined) candidates.push(textRecordCount + 1 + thumbnailRecordIndex);
      candidates.push(thumbnailRecordIndex);
    }
    if (firstImageRecord !== -1 && firstImageRecord !== 0xffffffff && firstImageRecord !== 4294967295) candidates.push(firstImageRecord);
    if (firstNonBook !== -1 && firstNonBook !== 0xffffffff && firstNonBook !== 4294967295) candidates.push(firstNonBook);

    function isValidImage(imgData) {
      if (!imgData || imgData.length < 4) return false;
      const isJpg = (imgData[0] === 0xFF && imgData[1] === 0xD8 && imgData[2] === 0xFF);
      const isPng = (imgData[0] === 0x89 && imgData[1] === 0x50 && imgData[2] === 0x4E && imgData[3] === 0x47);
      const isGif = (imgData[0] === 0x47 && imgData[1] === 0x49 && imgData[2] === 0x46 && imgData[3] === 0x38);
      return isJpg || isPng || isGif;
    }

    for (const recordIdx of candidates) {
      if (recordIdx > 0 && recordIdx < records.length) {
        try {
          const imgData = getRecordData(recordIdx);
          if (isValidImage(imgData)) {
            if (imgData[0] === 0x89 && imgData[1] === 0x50 && imgData[2] === 0x4E && imgData[3] === 0x47) coverMime = 'image/png';
            else if (imgData[0] === 0x47 && imgData[1] === 0x49 && imgData[2] === 0x46 && imgData[3] === 0x38) coverMime = 'image/gif';
            coverRecordBytes = imgData;
            break;
          }
        } catch(e) {}
      }
    }

    // Helper: Split text into chapters on string level using Regex
    function getSkeleton(content) {
      const match = content.match(/aid=["']([0-9A-Z]+)["']/i);
      if (match) {
        const val = decodeBase32(match[1]);
        if (val >= 0) return Math.floor(val / 1000000);
      }
      return 0;
    }

    const cleanHtml = fullHtml
      .replace(/<\\?xml\\b[^>]*\\?>/gi, '')
      .replace(/<!DOCTYPE\\b[^>]*>/gi, '')
      .replace(/<html\\b[^>]*>/gi, '')
      .replace(/<\\/html>/gi, '')
      .replace(/<head\\b[^>]*>/gi, '')
      .replace(/<\\/head>/gi, '')
      .replace(/<body\\b[^>]*>/gi, '')
      .replace(/<\\/body>/gi, '')
      .replace(/<title\\b[^>]*>.*?<\\/title>/gi, '')
      .replace(/<meta\\b[^>]*>/gi, '');

    const markerRegex = /<(mbp:pagebreak|pagebreak)\\b[^>]*>|<[^>]*style="[^"]*page-break-after\\s*:\\s*always[^"]*"[^>]*>|<(h1|h2)\\b[^>]*>([\\s\\S]*?)<\\/\\2>/gi;
    const markers = [];
    let match;
    while ((match = markerRegex.exec(cleanHtml)) !== null) {
      markers.push({
        index: match.index,
        length: match[0].length,
        tag: match[1] || match[2] || 'pagebreak',
        text: match[3] || '',
        fullText: match[0]
      });
    }

    const chapters = [];
    let chapterIndex = 1;

    if (markers.length > 2) {
      let lastPos = 0;
      for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
        const nextPos = marker.index;
        const content = cleanHtml.substring(lastPos, nextPos).trim();
        if (content.length > 50) {
          let title = "Chapter " + chapterIndex;
          if (i > 0) {
            title = markers[i - 1].text.replace(/<[^>]*>/g, '').trim().substring(0, 50) || title;
          } else {
            title = "Introduction";
          }
          chapters.push({
            title,
            href: "chapter-" + chapterIndex,
            skeleton: getSkeleton(content),
            content: content
          });
          chapterIndex++;
        }
        lastPos = marker.index + marker.length;
      }
      const content = cleanHtml.substring(lastPos).trim();
      if (content.length > 50) {
        let title = "Chapter " + chapterIndex;
        if (markers.length > 0) {
          title = markers[markers.length - 1].text.replace(/<[^>]*>/g, '').trim().substring(0, 50) || title;
        }
        chapters.push({
          title,
          href: "chapter-" + chapterIndex,
          skeleton: getSkeleton(content),
          content: content
        });
      }
    } else {
      const CHUNK_SIZE = 25000;
      let offset = 0;
      while (offset < cleanHtml.length) {
        let chunkEnd = offset + CHUNK_SIZE;
        if (chunkEnd < cleanHtml.length) {
          const nextTagOpen = cleanHtml.indexOf('<', chunkEnd);
          const nextTagClose = cleanHtml.indexOf('>', chunkEnd);
          if (nextTagOpen > -1 && nextTagOpen < nextTagClose) {
            chunkEnd = nextTagOpen;
          }
        }
        const content = cleanHtml.substring(offset, chunkEnd);
        chapters.push({
          title: "Chapter " + chapterIndex,
          href: "chapter-" + chapterIndex,
          skeleton: getSkeleton(content),
          content: content
        });
        offset = chunkEnd;
        chapterIndex++;
      }
    }

    // Extract embedded resource mapping indexes (images)
    const kindleEmbeds = [];
    const embedRegex = /kindle:embed:([0-9A-Z]+)(?:\\?[^"'>\\s]*)?/gi;
    let embedMatch;
    while ((embedMatch = embedRegex.exec(fullHtml)) !== null) {
      kindleEmbeds.push(embedMatch[1]);
    }

    const resources = {};
    const uniqueEmbeds = Array.from(new Set(kindleEmbeds));
    for (const embed of uniqueEmbeds) {
      const idx = decodeBase32(embed);
      if (idx !== -1 && firstImageRecord !== -1 && firstImageRecord !== 0xffffffff) {
        const recIdx = firstImageRecord + idx - 1;
        if (recIdx > 0 && recIdx < records.length) {
          try {
            const imgData = getRecordData(recIdx);
            if (isValidImage(imgData)) {
              let mime = 'image/jpeg';
              if (imgData[0] === 0x89 && imgData[1] === 0x50 && imgData[2] === 0x4E && imgData[3] === 0x47) mime = 'image/png';
              else if (imgData[0] === 0x47 && imgData[1] === 0x49 && imgData[2] === 0x46 && imgData[3] === 0x38) mime = 'image/gif';
              resources[embed] = { bytes: imgData, mime, recIdx };
            }
          } catch(e) {}
        }
      }
    }

    // Parse Frag Table
    let fragTable = null;
    try {
      const data0 = getRecordData(0);
      const view0 = new DataView(data0.buffer, data0.byteOffset, data0.byteLength);
      const fragIdx = view0.getUint32(mobiHeaderOffset + 232);
      if (fragIdx !== 0xffffffff && fragIdx > 0 && fragIdx < records.length) {
        const rootData = getRecordData(fragIdx);
        const rootDv = new DataView(rootData.buffer, rootData.byteOffset, rootData.byteLength);
        if (String.fromCharCode(rootData[0], rootData[1], rootData[2], rootData[3]) === 'INDX') {
          const indexCount = rootDv.getUint32(24);
          fragTable = {};
          for (let i = 1; i <= indexCount; i++) {
            const childIdx = fragIdx + i;
            if (childIdx >= records.length) break;
            const childData = getRecordData(childIdx);
            const childDv = new DataView(childData.buffer, childData.byteOffset, childData.byteLength);
            if (String.fromCharCode(childData[0], childData[1], childData[2], childData[3]) !== 'INDX') continue;
            
            const idxtOffset = childDv.getUint32(20);
            const subIndexCount = childDv.getUint32(24);
            const idxPositions = [];
            for (let j = 0; j < subIndexCount; j++) {
              idxPositions.push(childDv.getUint16(idxtOffset + 4 + 2 * j));
            }
            idxPositions.push(idxtOffset);
            for (let j = 0; j < subIndexCount; j++) {
              const startPos = idxPositions[j];
              const endPos = idxPositions[j+1];
              if (startPos >= childData.length) continue;
              const textLen = childData[startPos];
              const textBytes = childData.subarray(startPos + 1, startPos + 1 + textLen);
              let text = "";
              for (let k = 0; k < textBytes.length; k++) text += String.fromCharCode(textBytes[k]);
              const byteOffset = parseInt(text, 10);
              
              const vwiStart = startPos + 1 + textLen;
              const extraBytes = childData.subarray(vwiStart, endPos);
              const vwis = [];
              let p = 0;
              while (p < extraBytes.length) {
                let val = 0;
                let hasVal = false;
                while (p < extraBytes.length) {
                  const byte = extraBytes[p++];
                  val = (val << 7) | (byte & 0x7F);
                  if (byte & 0x80) {
                    hasVal = true;
                    break;
                  }
                }
                if (hasVal) vwis.push(val);
                else break;
              }
              if (vwis.length >= 3) {
                fragTable[vwis[2]] = { offset: byteOffset, skeleton: vwis[1] };
              }
            }
          }
        }
      }
    } catch(e) {}

    // Send back results
    const transferables = [arrayBuffer];
    if (coverRecordBytes) transferables.push(coverRecordBytes.buffer);
    for (const key in resources) {
      transferables.push(resources[key].bytes.buffer);
    }

    self.postMessage({
      success: true,
      metadata: {
        title,
        author,
        coverBytes: coverRecordBytes,
        coverMime,
        size: arrayBuffer.byteLength
      },
      chapters,
      fragTable,
      flowUrlsData,
      resources
    }, transferables);
  };
