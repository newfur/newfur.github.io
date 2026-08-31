package com.edgereader.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public class TtsRequestValidatorTest {
    private static final String TOKEN = "A".repeat(64);
    private static final String DATE = "Mon Aug 31 2026 12:34:56 GMT+0000 (Coordinated Universal Time)";

    @Test
    public void acceptsValidRequestAndBuildsBoundedSsml() throws Exception {
        TtsRequestValidator.Request request = TtsRequestValidator.validate(
                "Hello world", "en-US-AriaNeural", "0123456789abcdef0123456789abcdef", TOKEN, DATE, "+0%", "+0%");

        assertEquals("Hello world", request.text);
        assertTrue(request.ssml.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= TtsRequestValidator.MAX_SSML_BYTES);
    }

    @Test
    public void rejectsHeaderAndUrlInjectionWithStableCodes() {
        assertCode("INVALID_CONNECTION_ID", "id\r\nX-Evil: yes", TOKEN, DATE, "voice");
        assertCode("INVALID_TOKEN", "0123456789abcdef0123456789abcdef", "AABB&x=y", DATE, "voice");
        assertCode("INVALID_DATE", "0123456789abcdef0123456789abcdef", TOKEN, DATE + "\r\nX-Evil: yes", "voice");
        assertCode("INVALID_VOICE", "0123456789abcdef0123456789abcdef", TOKEN, DATE, "bad' voice");
    }

    @Test
    public void rejectsEmptyOrOversizedTextAndOversizedSsml() {
        assertTextCode("INVALID_TEXT", "");
        assertTextCode("INVALID_TEXT", "x".repeat(TtsRequestValidator.MAX_TEXT_CHARS + 1));
        assertTextCode("INVALID_SSML", "&".repeat(TtsRequestValidator.MAX_TEXT_CHARS));
    }

    private static void assertCode(String code, String connectionId, String token, String date, String voice) {
        try {
            TtsRequestValidator.validate("text", voice, connectionId, token, date, "+0%", "+0%");
            fail("Expected " + code);
        } catch (NativeBoundaryException error) {
            assertEquals(code, error.getCode());
        }
    }

    private static void assertTextCode(String code, String text) {
        try {
            TtsRequestValidator.validate(text, "en-US-AriaNeural", "0123456789abcdef0123456789abcdef", TOKEN, DATE, "+0%", "+0%");
            fail("Expected " + code);
        } catch (NativeBoundaryException error) {
            assertEquals(code, error.getCode());
        }
    }
}
