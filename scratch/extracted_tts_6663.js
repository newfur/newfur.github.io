Created At: 2026-05-25T03:50:59Z
Completed At: 2026-05-25T03:50:59Z
File Path: `file:///Users/burnfan/Documents/antigravity/mysterious-oppenheimer/reader/tts.js`
Total Lines: 906
Total Bytes: 29937
Showing lines 430 to 455
The following code has been modified to include a line number before every line, in the format: <line_number>: <original_line>. Please note that any changes targeting the original code should remove the line number, colon, and leading space.
430:       const audioBuffer = await this.audioCtx.decodeAudioData(audioData);
431:       
432:       this.audioQueue.push({
433:         chunkIndex,
434:         audioBuffer,
435:         metadata,
436:         sentences: chunk.sentences
437:       });
438:       
439:       // 依索引排序，防止多線程抓取順序錯亂
440:       this.audioQueue.sort((a, b) => a.chunkIndex - b.chunkIndex);
441:       
442:       // 驅動播放佇列
443:       this._playNextInQueue();
444:       this._fillPreFetchBuffer();
445:       
446:     } catch (e) {
447:       console.error(`Failed to fetch/decode chunk ${chunkIndex}:`, e);
448:       if (this.isPlaying) {
449:         // 容錯機制：若單塊加載失敗，標記為已播，直接播放下一塊
450:         this.currentPlayingChunkIndex = Math.max(this.currentPlayingChunkIndex, chunkIndex);
451:         this._playNextInQueue();
452:         this._fillPreFetchBuffer();
453:       }
454:     }
455:   }
The above content does NOT show the entire file contents. If you need to view any lines of the file which were not shown to complete your task, call this tool again to view those lines.
