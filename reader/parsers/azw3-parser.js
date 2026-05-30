// reader/parsers/azw3-parser.js
// MOBI 與 AZW3 電子書二進位解析器，支持 PDB 頭解析、EXTH 元數據提取與 PalmDoc 數據解壓

function getNumericValue(uint8Array) {
  if (!uint8Array || uint8Array.length === 0) return -1;
  
  // 檢查是否全為 ASCII 數字字元 (可包含空格、換行等空白字元)
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

export function decodeBase32(str) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let val = 0;
  for (let i = 0; i < str.length; i++) {
    const code = chars.indexOf(str[i].toUpperCase());
    if (code === -1) return -1;
    val = val * 32 + code;
  }
  return val;
}

export class Azw3Parser {
  constructor(fileBlob) {
    this.fileBlob = fileBlob;
    this.arrayBuffer = null;
    this.view = null;
    this.records = [];
    this.compression = 0;
    this.textLength = 0;
    this.mobiHeaderOffset = 0;
    this.title = '';
    this.author = '';
    this.coverRecordIndex = -1;
    this.thumbnailRecordIndex = -1;
  }

  async parse() {
    this.arrayBuffer = await this.fileBlob.arrayBuffer();
    this.view = new DataView(this.arrayBuffer);
    this.title = this.fileBlob.name.replace(/\.(mobi|azw3)$/i, '');

    // 1. 解析 PDB 頭資訊
    const numRecords = this.view.getUint16(76);
    
    // 2. 獲取所有 Record 的 Offset 和 ID
    for (let i = 0; i < numRecords; i++) {
      const offset = this.view.getUint32(78 + i * 8);
      const attributes = this.view.getUint8(78 + i * 8 + 4);
      const uniqueId = this.view.getUint32(78 + i * 8 + 4) & 0x00FFFFFF;
      this.records.push({ offset, attributes, uniqueId });
    }

    // 3. 解析 Record 0 (包含 MOBI Header)
    if (this.records.length > 0) {
      this._parseRecord0();
    }

    // 4. 解析 EXTH 元數據 (在 Record 0 的 MOBI Header 後面)
    this._parseEXTH();

    // 5. 解壓文本數據
    // MOBI 文本記錄從 Record 1 開始，長度為 numTextRecords
    const numTextRecords = this.textRecordCount;
    let fullHtml = '';
    const resourceUrls = [];
    const uniqueResourceUrls = new Set();
    
    // 用於獲取內嵌圖片/資源起點
    let firstImageRecord = -1;
    let firstNonBook = -1;
    if (this.records.length > 0) {
      try {
        const data0 = this._getRecordData(0);
        const view0 = new DataView(data0.buffer, data0.byteOffset, data0.byteLength);
        const offsetFirstImage = this.mobiHeaderOffset + 92;
        const offsetFirstNonBook = this.mobiHeaderOffset + 64;
        if (data0.length >= offsetFirstImage + 4) {
          firstImageRecord = view0.getUint32(offsetFirstImage);
        }
        if (data0.length >= offsetFirstNonBook + 4) {
          firstNonBook = view0.getUint32(offsetFirstNonBook);
        }
      } catch (e) {
        console.warn('Failed to parse candidate resource indices:', e);
      }
    }
    
    if (this.compression === 2 || this.compression === 1) {
      // PalmDoc 壓縮 或 無壓縮
      const textRecords = [];
      for (let i = 1; i <= numTextRecords && i < this.records.length; i++) {
        const recordData = this._getRecordData(i);
        
        // 先計算並移除 trailing bytes
        const trailingSize = this._getTrailingBytesSize(recordData, recordData.length);
        const cleanRecordData = trailingSize > 0 ? recordData.subarray(0, recordData.length - trailingSize) : recordData;
        
        const decompressed = this.compression === 2 ? this._decompressPalmDoc(cleanRecordData) : cleanRecordData;
        textRecords.push(decompressed);
      }
      
      // 合併所有二進位緩衝區以避免多字節 UTF-8 字元在邊界處被截斷導致亂碼
      const totalLength = textRecords.reduce((acc, buf) => acc + buf.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const buf of textRecords) {
        combined.set(buf, offset);
        offset += buf.length;
      }

      // 尋找 FDST (Flow Data Store Table) 記錄
      let fdstRecordIndex = -1;
      for (let i = 1; i < this.records.length; i++) {
        try {
          const data = this._getRecordData(i);
          if (data.length >= 4 && String.fromCharCode(data[0], data[1], data[2], data[3]) === 'FDST') {
            fdstRecordIndex = i;
            break;
          }
        } catch(e) {}
      }

      const decoder = new TextDecoder('utf-8');
      const flowUrls = {};
      let htmlBytes = combined;

      if (fdstRecordIndex !== -1) {
        try {
          const fdstData = this._getRecordData(fdstRecordIndex);
          const fdstDv = new DataView(fdstData.buffer, fdstData.byteOffset, fdstData.byteLength);
          const numFlows = fdstDv.getUint32(8);
          const flows = [];
          for (let i = 0; i < numFlows; i++) {
            const start = fdstDv.getUint32(12 + i * 8);
            const end = fdstDv.getUint32(12 + i * 8 + 4);
            flows.push({ start, end });
          }

          // Flow 0 是主要 HTML 內容
          if (flows.length > 0) {
            htmlBytes = combined.subarray(flows[0].start, Math.min(combined.length, flows[0].end));
            fullHtml = decoder.decode(htmlBytes);
          } else {
            fullHtml = decoder.decode(combined);
          }

          // 解析並抽取其它 Flow (如 CSS 樣式表)
          for (let i = 1; i < flows.length; i++) {
            const flowStart = flows[i].start;
            const flowEnd = Math.min(combined.length, flows[i].end);
            if (flowStart < combined.length) {
              const flowBytes = combined.subarray(flowStart, flowEnd);
              const flowText = decoder.decode(flowBytes);
              const blob = new Blob([flowText], { type: 'text/css' });
              const url = URL.createObjectURL(blob);
              flowUrls[i] = url;
              uniqueResourceUrls.add(url);
            }
          }
        } catch (e) {
          console.warn('Failed to parse FDST flows, falling back to full combined text decoding:', e);
          fullHtml = decoder.decode(combined);
        }
      } else {
        fullHtml = decoder.decode(combined);
      }

      // 替換 kindle:flow: 連結
      fullHtml = fullHtml.replace(/kindle:flow:([0-9A-Z]+)(?:\?[^"'>\s]*)?/gi, (match, p1) => {
        const index = decodeBase32(p1);
        if (flowUrls[index]) {
          return flowUrls[index];
        }
        return match;
      });

      // 構建獲取內嵌圖片 Object URL 的函數
      const embedUrls = {};
      const getEmbedUrl = (indexStr) => {
        const index = decodeBase32(indexStr);
        if (index === -1 || firstImageRecord === -1 || firstImageRecord === 0xffffffff) return null;
        const recIdx = firstImageRecord + index - 1;
        if (recIdx <= 0 || recIdx >= this.records.length) return null;
        
        if (embedUrls[recIdx]) return embedUrls[recIdx];
        
        try {
          const imgData = this._getRecordData(recIdx);
          if (this._isValidImage(imgData)) {
            let mime = 'image/jpeg';
            if (imgData[0] === 0x89 && imgData[1] === 0x50 && imgData[2] === 0x4E && imgData[3] === 0x47) mime = 'image/png';
            else if (imgData[0] === 0x47 && imgData[1] === 0x49 && imgData[2] === 0x46 && imgData[3] === 0x38) mime = 'image/gif';
            
            const blob = new Blob([imgData], { type: mime });
            const url = URL.createObjectURL(blob);
            embedUrls[recIdx] = url;
            uniqueResourceUrls.add(url);
            return url;
          }
        } catch (e) {
          console.warn('Failed to extract embed resource:', recIdx, e);
        }
        return null;
      };

      // 替換 kindle:embed: 連結
      fullHtml = fullHtml.replace(/kindle:embed:([0-9A-Z]+)(?:\?[^"'>\s]*)?/gi, (match, p1) => {
        const url = getEmbedUrl(p1);
        if (url) {
          return url;
        }
        return match;
      });

    } else {
      // HUFF/CDIC 或其他壓縮暫不完全支持，返回友好提示或原文本
      fullHtml = `
        <div style="padding: 20px; text-align: center;">
          <h3 style="color: var(--text-color);">此 MOBI/AZW3 檔案採用了進階壓縮 (HUFF/CDIC) 或 DRM 加密</h3>
          <p style="color: var(--text-muted);">暫時無法直接在瀏覽器中完全解壓縮。建議將其轉換為 EPUB 格式後導入閱讀。</p>
        </div>
      `;
    }

    // 6. 解析並匹配封面圖 (如果存在封面 Record，主要用於書架封面渲染)
    let coverBlob = null;
    const candidates = [];
    
    if (this.coverRecordIndex !== -1 && this.coverRecordIndex !== 0xffffffff && this.coverRecordIndex !== 4294967295) {
      if (firstImageRecord !== -1 && firstImageRecord !== 0xffffffff && firstImageRecord !== 4294967295) {
        candidates.push(firstImageRecord + this.coverRecordIndex);
      }
      if (firstNonBook !== -1 && firstNonBook !== 0xffffffff && firstNonBook !== 4294967295) {
        candidates.push(firstNonBook + this.coverRecordIndex);
      }
      if (this.textRecordCount !== undefined) {
        candidates.push(this.textRecordCount + 1 + this.coverRecordIndex);
      }
      candidates.push(this.coverRecordIndex);
    }

    if (this.thumbnailRecordIndex !== -1 && this.thumbnailRecordIndex !== 0xffffffff && this.thumbnailRecordIndex !== 4294967295) {
      if (firstImageRecord !== -1 && firstImageRecord !== 0xffffffff && firstImageRecord !== 4294967295) {
        candidates.push(firstImageRecord + this.thumbnailRecordIndex);
      }
      if (firstNonBook !== -1 && firstNonBook !== 0xffffffff && firstNonBook !== 4294967295) {
        candidates.push(firstNonBook + this.thumbnailRecordIndex);
      }
      if (this.textRecordCount !== undefined) {
        candidates.push(this.textRecordCount + 1 + this.thumbnailRecordIndex);
      }
      candidates.push(this.thumbnailRecordIndex);
    }
    
    if (firstImageRecord !== -1 && firstImageRecord !== 0xffffffff && firstImageRecord !== 4294967295) {
      candidates.push(firstImageRecord);
    }
    if (firstNonBook !== -1 && firstNonBook !== 0xffffffff && firstNonBook !== 4294967295) {
      candidates.push(firstNonBook);
    }
    if (this.textRecordCount !== undefined) {
      candidates.push(this.textRecordCount + 1);
    }

    for (const recordIdx of candidates) {
      if (recordIdx > 0 && recordIdx < this.records.length) {
        try {
          const imgData = this._getRecordData(recordIdx);
          if (this._isValidImage(imgData)) {
            let mime = 'image/jpeg';
            if (imgData[0] === 0x89 && imgData[1] === 0x50 && imgData[2] === 0x4E && imgData[3] === 0x47) mime = 'image/png';
            else if (imgData[0] === 0x47 && imgData[1] === 0x49 && imgData[2] === 0x46 && imgData[3] === 0x38) mime = 'image/gif';
            
            coverBlob = new Blob([imgData], { type: mime });
            console.log(`Successfully found cover image at record index: ${recordIdx}, MIME: ${mime}`);
            break;
          }
        } catch (e) {
          // Ignore
        }
      }
    }

    // 優先嘗試解析 NCX 索引目錄以獲得完美的章節結構與名稱，否則退回到原有 DOM/字數切分
    let chapters = null;
    const tocEntries = this._parseNCXTOC(htmlBytes);
    
    if (tocEntries) {
      // 按字元偏移量排序
      tocEntries.sort((a, b) => a.charOffset - b.charOffset);
      
      const uniqueOffsets = Array.from(new Set(tocEntries.map(e => e.charOffset))).sort((a, b) => a - b);
      if (uniqueOffsets.length > 0 && uniqueOffsets[0] > 0) {
        uniqueOffsets.unshift(0);
        tocEntries.unshift({
          title: this.title || "Introduction",
          charOffset: 0,
          depth: 0
        });
      }
      
      chapters = [];
      tocEntries.forEach((entry, idx) => {
        const start = entry.charOffset;
        const nextIdx = uniqueOffsets.indexOf(start) + 1;
        const end = nextIdx < uniqueOffsets.length ? uniqueOffsets[nextIdx] : fullHtml.length;
        const content = fullHtml.substring(start, end);
        
        chapters.push({
          title: entry.title,
          href: `chapter-${idx + 1}`,
          depth: entry.depth || 0,
          getContent: () => content
        });
      });
      console.log(`Successfully parsed NCX TOC with ${chapters.length} chapters.`);
    } else {
      chapters = this._splitIntoChapters(fullHtml);
    }
    const fragTable = this._parseFragTable();
    resourceUrls.push(...Array.from(uniqueResourceUrls));

    return {
      metadata: {
        title: this.title || 'Unknown MOBI Book',
        author: this.author || 'Unknown Author',
        cover: coverBlob,
        size: this.fileBlob.size
      },
      chapters,
      fragTable,
      resourceUrls
    };
  }

  // 解析 MOBI/KF8 檔案位置與 fragment 對照表 (INDX 格式)
  _parseFragTable() {
    try {
      const data0 = this._getRecordData(0);
      const view0 = new DataView(data0.buffer, data0.byteOffset, data0.byteLength);
      const fragIdx = view0.getUint32(this.mobiHeaderOffset + 232);
      if (fragIdx === 0xffffffff || fragIdx === 0 || fragIdx >= this.records.length) {
        return null;
      }
      
      const rootData = this._getRecordData(fragIdx);
      const rootDv = new DataView(rootData.buffer, rootData.byteOffset, rootData.byteLength);
      if (String.fromCharCode(rootData[0], rootData[1], rootData[2], rootData[3]) !== 'INDX') {
        return null;
      }
      
      const indexCount = rootDv.getUint32(24);
      const fragTable = {};
      
      for (let i = 1; i <= indexCount; i++) {
        const childIdx = fragIdx + i;
        if (childIdx >= this.records.length) break;
        
        const childData = this._getRecordData(childIdx);
        const childDv = new DataView(childData.buffer, childData.byteOffset, childData.byteLength);
        if (String.fromCharCode(childData[0], childData[1], childData[2], childData[3]) !== 'INDX') {
          continue;
        }
        
        const idxtOffset = childDv.getUint32(20);
        const subIndexCount = childDv.getUint32(24);
        
        const idxPositions = [];
        for (let j = 0; j < subIndexCount; j++) {
          const pos = childDv.getUint16(idxtOffset + 4 + 2 * j);
          idxPositions.push(pos);
        }
        idxPositions.push(idxtOffset);
        
        for (let j = 0; j < subIndexCount; j++) {
          const startPos = idxPositions[j];
          const endPos = idxPositions[j+1];
          if (startPos >= childData.length) continue;
          
          const textLen = childData[startPos];
          const textBytes = childData.subarray(startPos + 1, startPos + 1 + textLen);
          const text = String.fromCharCode.apply(null, textBytes);
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
            if (hasVal) {
              vwis.push(val);
            } else {
              break;
            }
          }
          
          if (vwis.length >= 3) {
            const skeleton = vwis[1];
            const fid = vwis[2];
            fragTable[fid] = {
              offset: byteOffset,
              skeleton: skeleton
            };
          }
        }
      }
      return fragTable;
    } catch (e) {
      console.warn('Failed to parse fragment table:', e);
    }
    return null;
  }

  // 解析 NCX Table of Contents (INDX 目錄樹)
  _parseNCXTOC(combined) {
    if (this.ncxIndex === undefined || this.ncxIndex === 0xffffffff || this.ncxIndex >= this.records.length) {
      return null;
    }
    try {
      const rootData = this._getRecordData(this.ncxIndex);
      if (rootData.length < 4 || String.fromCharCode(rootData[0], rootData[1], rootData[2], rootData[3]) !== 'INDX') {
        return null;
      }
      const rootDv = new DataView(rootData.buffer, rootData.byteOffset, rootData.byteLength);
      const numChildRecords = rootDv.getUint32(24);
      
      let tagxOffset = -1;
      for (let i = 0; i < rootData.length - 4; i++) {
        if (rootData[i] === 0x54 && rootData[i+1] === 0x41 && rootData[i+2] === 0x47 && rootData[i+3] === 0x58) { // 'TAGX'
          tagxOffset = i;
          break;
        }
      }
      if (tagxOffset === -1) return null;
      
      const tagxLen = rootDv.getUint32(tagxOffset + 4);
      const controlByteCount = rootDv.getUint32(tagxOffset + 8);
      
      const tags = [];
      let tagP = tagxOffset + 12;
      const tagEnd = tagxOffset + tagxLen;
      while (tagP + 4 <= tagEnd) {
        const tagId = rootData[tagP];
        const numValues = rootData[tagP + 1];
        const mask = rootData[tagP + 2];
        const endOffset = rootData[tagP + 3];
        tags.push({ tagId, numValues, mask, endOffset });
        tagP += 4;
      }
      
      const valRecIdx = this.ncxIndex + numChildRecords + 1;
      if (valRecIdx >= this.records.length) return null;
      const labelBytes = this._getRecordData(valRecIdx);
      const tocEntries = [];
      const decoder = new TextDecoder('utf-8');
      
      for (let i = 1; i <= numChildRecords; i++) {
        const childIdx = this.ncxIndex + i;
        if (childIdx >= this.records.length) break;
        const childData = this._getRecordData(childIdx);
        if (childData.length < 4 || String.fromCharCode(childData[0], childData[1], childData[2], childData[3]) !== 'INDX') {
          continue;
        }
        const childDv = new DataView(childData.buffer, childData.byteOffset, childData.byteLength);
        const idxtOffset = childDv.getUint32(20);
        const numEntries = childDv.getUint32(24);
        
        const idxtPositions = [];
        for (let j = 0; j < numEntries; j++) {
          idxtPositions.push(childDv.getUint16(idxtOffset + 4 + j * 2));
        }
        idxtPositions.push(idxtOffset);
        
        for (let j = 0; j < numEntries; j++) {
          const startPos = idxtPositions[j];
          const endPos = idxtPositions[j + 1];
          if (startPos >= childData.length) continue;
          const entry = childData.subarray(startPos, endPos);
          const keyLen = entry[0];
          const key = entry.subarray(1, 1 + keyLen);
          const controlByte = entry[1 + keyLen];
          
          const vwis = [];
          let p = 1 + keyLen + 1;
          while (p < entry.length) {
            let val = 0;
            let hasVal = false;
            while (p < entry.length) {
              const byte = entry[p++];
              val = (val << 7) | (byte & 0x7F);
              if (byte & 0x80) {
                hasVal = true;
                break;
              }
            }
            if (hasVal) {
              vwis.push(val);
            } else {
              break;
            }
          }
          
          let vwiIdx = 0;
          const entryTags = {};
          for (const tag of tags) {
            if (controlByte & tag.mask) {
              const vals = [];
              for (let k = 0; k < tag.numValues; k++) {
                if (vwiIdx < vwis.length) {
                  vals.push(vwis[vwiIdx++]);
                }
              }
              entryTags[tag.tagId] = vals;
            }
          }
          
          const pos = entryTags[1] ? entryTags[1][0] : undefined;
          const labelOffset = entryTags[3] ? entryTags[3][0] : undefined;
          const depth = entryTags[4] ? entryTags[4][0] : 0;
          
          if (pos !== undefined && labelOffset !== undefined) {
            let label = '';
            if (labelOffset >= 0 && labelOffset < labelBytes.length) {
              const lenByte = labelBytes[labelOffset];
              if (lenByte & 0x80) {
                const labelLen = lenByte & 0x7F;
                if (labelOffset + 1 + labelLen <= labelBytes.length) {
                  label = decoder.decode(labelBytes.subarray(labelOffset + 1, labelOffset + 1 + labelLen)).trim();
                }
              }
            }
            if (label) {
              // 映射到解碼後的 HTML 字符偏移量
              const sliceBytes = combined.subarray(0, pos);
              const charOffset = decoder.decode(sliceBytes).length;
              tocEntries.push({ title: label, pos, depth, charOffset });
            }
          }
        }
      }
      return tocEntries.length > 0 ? tocEntries : null;
    } catch (e) {
      console.warn("Failed to parse NCX Table of Contents:", e);
    }
    return null;
  }

  // 獲取指定 Record 的二進位數據
  _getRecordData(index) {
    const start = this.records[index].offset;
    const end = (index + 1 < this.records.length) ? this.records[index + 1].offset : this.arrayBuffer.byteLength;
    return new Uint8Array(this.arrayBuffer, start, end - start);
  }

  // 檢查是否為有效圖片（JPEG/PNG/GIF）的二進位特徵
  _isValidImage(imgData) {
    if (!imgData || imgData.length < 4) return false;
    const isJpg = (imgData[0] === 0xFF && imgData[1] === 0xD8 && imgData[2] === 0xFF);
    const isPng = (imgData[0] === 0x89 && imgData[1] === 0x50 && imgData[2] === 0x4E && imgData[3] === 0x47);
    const isGif = (imgData[0] === 0x47 && imgData[1] === 0x49 && imgData[2] === 0x46 && imgData[3] === 0x38);
    return isJpg || isPng || isGif;
  }

  // 解析 Record 0 頭部
  _parseRecord0() {
    const data = this._getRecordData(0);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // 獲取壓縮類型 (Record 0 的前 2 個字節)
    this.compression = view.getUint16(0);
    
    // 獲取文字記錄總數
    this.textRecordCount = view.getUint16(8);

    // 動態尋找 MOBI 標誌的偏移量
    let mobiOffset = -1;
    for (let i = 0; i < data.length - 4; i++) {
      if (data[i] === 0x4D && data[i+1] === 0x4F && data[i+2] === 0x42 && data[i+3] === 0x49) {
        mobiOffset = i;
        break;
      }
    }
    
    this.mobiHeaderOffset = mobiOffset !== -1 ? mobiOffset : 16;
    
    // 確保有足夠的長度讀取 MOBI Header
    if (mobiOffset !== -1 && data.length >= this.mobiHeaderOffset + 92 + 4) {
      // 獲取第一個資源 Record 的索引 (用於獲取封面圖)
      // FirstImageRecordNumber 位於 MOBI Header 偏移 92
      this.firstResourceRecordIndex = view.getUint32(this.mobiHeaderOffset + 92);
    } else {
      this.firstResourceRecordIndex = -1;
    }

    // 獲取 EXTH 標記/額外數據標記 (Extra Data Flags)
    this.extraDataFlags = 0;
    this.ncxIndex = 0xffffffff;
    if (data.length >= this.mobiHeaderOffset + 16) {
      const headerLength = view.getUint32(this.mobiHeaderOffset + 4);
      const mobiVersion = view.getUint32(this.mobiHeaderOffset + 12);
      if (headerLength >= 228 && mobiVersion >= 5 && data.length >= this.mobiHeaderOffset + 228) {
        this.extraDataFlags = view.getUint16(this.mobiHeaderOffset + 226);
        this.ncxIndex = view.getUint32(this.mobiHeaderOffset + 228);
        console.log(`Parsed MOBI Header: version=${mobiVersion}, headerLength=${headerLength}, extraDataFlags=0x${this.extraDataFlags.toString(16)}, ncxIndex=${this.ncxIndex}`);
      }
    }
  }

  // 解析 EXTH 元數據
  _parseEXTH() {
    try {
      const data = this._getRecordData(0);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      
      const mobiHeaderLength = view.getUint32(this.mobiHeaderOffset + 4);
      const exthOffset = this.mobiHeaderOffset + mobiHeaderLength;
      
      // 檢查 EXTH 標誌
      if (exthOffset + 12 > data.length) return;
      const exthIdentifier = String.fromCharCode(data[exthOffset], data[exthOffset+1], data[exthOffset+2], data[exthOffset+3]);
      
      if (exthIdentifier === 'EXTH') {
        const exthLength = view.getUint32(exthOffset + 4);
        const numItems = view.getUint32(exthOffset + 8);
        
        let offset = exthOffset + 12;
        const decoder = new TextDecoder('utf-8');
        
        for (let i = 0; i < numItems; i++) {
          if (offset + 8 > data.length) break;
          const type = view.getUint32(offset);
          const length = view.getUint32(offset + 4);
          
          if (offset + length > data.length) break;
          const valData = data.subarray(offset + 8, offset + length);
          
          if (type === 100) { // 作者
            this.author = decoder.decode(valData).trim();
          } else if (type === 201) { // 封面圖 Record 索引
            this.coverRecordIndex = getNumericValue(valData);
          } else if (type === 202) { // 縮圖 Record 索引 (也可以作為封面候選)
            this.thumbnailRecordIndex = getNumericValue(valData);
          } else if (type === 105) { // 出版商，可以作為作者備份
            if (!this.author) this.author = decoder.decode(valData).trim();
          } else if (type === 503) { // 書名
            this.title = decoder.decode(valData).trim();
          }
          
          offset += length;
        }
      }
    } catch (e) {
      console.warn('Failed to parse EXTH:', e);
    }
  }

  // 獲取記錄尾部附加的元數據字節大小
  _getTrailingBytesSize(ptr, size) {
    if (!this.extraDataFlags) return 0;
    
    let num = 0;
    
    // 獲取除了最低位 (flags & 1) 以外的所有 trailing entries 大小
    let f = this.extraDataFlags >> 1;
    while (f > 0) {
      if (f & 1) {
        num += this._getSizeOfTrailingDataEntry(ptr, size - num);
      }
      f >>= 1;
    }
    
    // 處理最低位 (flags & 1) - 多字節字元重疊
    if (this.extraDataFlags & 1) {
      if (size - num > 0) {
        const lastByte = ptr[size - num - 1];
        num += (lastByte & 3) + 1;
      }
    }
    
    return num;
  }

  // 讀取變長整數 (MOBI 格式元數據長度專用編碼)
  _getSizeOfTrailingDataEntry(ptr, size) {
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

  // PalmDoc LZ77 解密算法
  _decompressPalmDoc(data) {
    const output = [];
    let i = 0;
    const len = data.length;

    while (i < len) {
      const b = data[i++];

      if (b === 0) {
        // 0 則原樣輸出
        output.push(0);
      } else if (b <= 8) {
        // 1-8：複製隨後的 b 個字節
        for (let j = 0; j < b && i < len; j++) {
          output.push(data[i++]);
        }
      } else if (b <= 0x7f) {
        // 9-0x7f：原樣輸出
        output.push(b);
      } else if (b <= 0xbf) {
        // 0x80-0xbf：壓縮標記，代表複製之前的數據
        if (i >= len) break;
        const b2 = data[i++];
        const pair = ((b << 8) | b2) & 0x3fff;
        const distance = pair >> 3;
        const length = (pair & 0x07) + 3;

        const outLen = output.length;
        for (let j = 0; j < length; j++) {
          // 自輸出緩衝區的前 distance 位置拷貝
          const srcIdx = outLen - distance + j;
          if (srcIdx >= 0 && srcIdx < output.length) {
            output.push(output[srcIdx]);
          } else {
            output.push(32); // 越界安全保護
          }
        }
      } else {
        // 0xc0-0xff：複製一個空格 + (b ^ 0x80)
        output.push(32); // Space
        output.push(b ^ 0x80);
      }
    }

    return new Uint8Array(output);
  }

  // 將龐大的 HTML 拆分為章節
  _splitIntoChapters(fullHtml) {
    // 移除 XML 宣告、DOCTYPE、以及重複的 html, head, body, title, meta 標籤，只保留實質內容與樣式連結
    const cleanHtml = fullHtml
      .replace(/<\?xml\b[^>]*\?>/gi, '')
      .replace(/<!DOCTYPE\b[^>]*>/gi, '')
      .replace(/<html\b[^>]*>/gi, '')
      .replace(/<\/html>/gi, '')
      .replace(/<head\b[^>]*>/gi, '')
      .replace(/<\/head>/gi, '')
      .replace(/<body\b[^>]*>/gi, '')
      .replace(/<\/body>/gi, '')
      .replace(/<title\b[^>]*>.*?<\/title>/gi, '')
      .replace(/<meta\b[^>]*>/gi, '');

    const parser = new DOMParser();
    const doc = parser.parseFromString(cleanHtml, 'text/html');
    const body = doc.body;
    
    const getSkeleton = (content) => {
      const match = content.match(/aid=["']([0-9A-Z]+)["']/i);
      if (match) {
        const val = decodeBase32(match[1]);
        if (val >= 0) return Math.floor(val / 1000000);
      }
      return 0;
    };

    // 判斷兩個標記之間是否有實質內容（例如非空白文字、圖片、表格等）
    function areMarkersAdjacent(node1, node2) {
      try {
        const range = doc.createRange();
        range.setStartAfter(node1);
        range.setEndBefore(node2);
        
        const text = range.toString().trim();
        if (text.length > 0) return false;
        
        const fragment = range.cloneContents();
        const hasMedia = fragment.querySelector('img, svg, image, table, iframe');
        if (hasMedia) return false;
        
        return true;
      } catch (e) {
        console.warn('Failed to check if markers are adjacent:', e);
        return false;
      }
    }

    // 尋找章節標記
    const rawMarkers = Array.from(body.querySelectorAll('mbp\\:pagebreak, pagebreak, [style*="page-break-after"], h1, h2'));
    
    // 過濾相鄰的標記，避免將連續的標題（例如中文標題與英文副標題）或分頁符與標題拆分成多個極短的空白章節
    const markers = [];
    let lastMarker = null;
    for (let i = 0; i < rawMarkers.length; i++) {
      const marker = rawMarkers[i];
      if (lastMarker) {
        if (areMarkersAdjacent(lastMarker, marker)) {
          continue;
        }
      }
      markers.push(marker);
      lastMarker = marker;
    }
    
    const chapters = [];
    let chapterIndex = 1;
    
    // 輔助函數：在指定節點處對 DOM 樹進行垂直切割，以便處理嵌套的 heading/pagebreak
    function splitDOMTreeAtNode(root, marker) {
      let curr = marker;
      while (curr.parentNode && curr.parentNode !== root) {
        const parent = curr.parentNode;
        const parentClone = parent.cloneNode(false); // 僅複製標籤與屬性，不複製子節點
        
        let sibling = curr;
        while (sibling) {
          const next = sibling.nextSibling;
          parentClone.appendChild(sibling);
          sibling = next;
        }
        
        parent.parentNode.insertBefore(parentClone, parent.nextSibling);
        curr = parentClone;
      }
      return curr;
    }
    
    if (markers.length > 2) {
      // 在所有標記節點處切割 DOM 樹，使其全部提升為 body 的直屬子節點
      const splitPoints = [];
      markers.forEach(marker => {
        try {
          const splitNode = splitDOMTreeAtNode(body, marker);
          splitPoints.push(splitNode);
        } catch (e) {
          console.warn('Failed to split tree at marker:', marker, e);
        }
      });
      
      // 遍歷 body 直屬子節點，將兩次切割之間的元素歸為一個章節
      let currentContainer = document.createElement('div');
      let curr = body.firstChild;
      let markerIdx = 0;
      
      while (curr) {
        const next = curr.nextSibling;
        
        if (curr === splitPoints[markerIdx]) {
          const content = currentContainer.innerHTML.trim();
          if (content.length > 50) {
            let title = `Chapter ${chapterIndex}`;
            if (markerIdx > 0) {
              // 章節的標題為啟動該章節的 marker (即前一個切割點) 內部的文字
              title = markers[markerIdx - 1].textContent.trim().substring(0, 50) || title;
            } else {
              title = "Introduction";
            }
            chapters.push({
              title,
              href: `chapter-${chapterIndex}`,
              skeleton: getSkeleton(content),
              getContent: () => content
            });
            chapterIndex++;
          }
          currentContainer = document.createElement('div');
          markerIdx++;
        }
        
        currentContainer.appendChild(curr);
        curr = next;
      }
      
      // 處理最後一個章節
      const content = currentContainer.innerHTML.trim();
      if (content.length > 50) {
        let title = `Chapter ${chapterIndex}`;
        if (markerIdx > 0) {
          title = markers[markerIdx - 1].textContent.trim().substring(0, 50) || title;
        }
        chapters.push({
          title,
          href: `chapter-${chapterIndex}`,
          skeleton: getSkeleton(content),
          getContent: () => content
        });
      }
    } else {
      // 若無章節標記，直接以字數進行切分
      const bodyText = body.innerHTML;
      const CHUNK_SIZE = 25000;
      let offset = 0;
      let chapterIndex = 1;
      
      while (offset < bodyText.length) {
        let chunkEnd = offset + CHUNK_SIZE;
        if (chunkEnd < bodyText.length) {
          const nextTagOpen = bodyText.indexOf('<', chunkEnd);
          const nextTagClose = bodyText.indexOf('>', chunkEnd);
          if (nextTagOpen > -1 && nextTagOpen < nextTagClose) {
            chunkEnd = nextTagOpen; // 在標籤開始前切斷
          }
        }
        
        const content = bodyText.substring(offset, chunkEnd);
        chapters.push({
          title: `Chapter ${chapterIndex}`,
          href: `chapter-${chapterIndex}`,
          skeleton: getSkeleton(content),
          getContent: () => content
        });
        
        offset = chunkEnd;
        chapterIndex++;
      }
    }
    
    return chapters;
  }
}
