package com.edgereader.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SsmlBuilderTest {
    @Test
    public void normalizesTextEscapesAttributesAndUsesVoiceLocale() {
        String ssml = SsmlBuilder.build(" hello\u0000   world ", "zh-TW-HsiaoChenNeural' bad", "+1%'", "+0%&");

        assertTrue(ssml.contains("xml:lang='zh-TW'"));
        assertTrue(ssml.contains("name='zh-TW-HsiaoChenNeural&apos; bad'"));
        assertTrue(ssml.contains("rate='+1%&apos;'"));
        assertTrue(ssml.contains("volume='+0%&amp;'"));
        assertTrue(ssml.contains(">hello world</prosody>"));
        assertFalse(ssml.contains("\u0000"));
    }

    @Test
    public void localeFallsBackWithoutHardcodingEnglishForValidVoices() {
        assertTrue(SsmlBuilder.build("text", "ja-JP-NanamiNeural", "+0%", "+0%").contains("xml:lang='ja-JP'"));
        assertTrue(SsmlBuilder.build("text", "invalid", "+0%", "+0%").contains("xml:lang='und'"));
    }
}
