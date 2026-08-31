package com.edgereader.app;

import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

final class TtsRequestValidator {
    static final int MAX_TEXT_CHARS = 12000;
    static final int MAX_SSML_BYTES = 48000;

    private static final Pattern CONNECTION_ID = Pattern.compile("^[A-Fa-f0-9]{32}$");
    private static final Pattern TOKEN = Pattern.compile("^[A-Fa-f0-9]{64}$");
    private static final Pattern DATE = Pattern.compile(
            "^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) "
                    + "(0[1-9]|[12][0-9]|3[01]) [0-9]{4} ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] "
                    + "GMT\\+0000 \\(Coordinated Universal Time\\)$");
    private static final Pattern VOICE = Pattern.compile("^[A-Za-z0-9._-]{1,128}$");
    private static final Pattern PROSODY = Pattern.compile("^[+-]?[0-9]{1,3}%$");

    static final class Request {
        final String text;
        final String voice;
        final String connectionId;
        final String token;
        final String date;
        final String ssml;

        Request(String text, String voice, String connectionId, String token, String date, String ssml) {
            this.text = text;
            this.voice = voice;
            this.connectionId = connectionId;
            this.token = token;
            this.date = date;
            this.ssml = ssml;
        }
    }

    private TtsRequestValidator() {}

    static Request validate(String text, String voice, String connectionId, String token, String date,
                            String rate, String volume) throws NativeBoundaryException {
        if (text == null || text.trim().isEmpty() || text.length() > MAX_TEXT_CHARS) invalid(NativeError.INVALID_TEXT);
        if (!matches(VOICE, voice)) invalid(NativeError.INVALID_VOICE);
        if (!matches(CONNECTION_ID, connectionId)) invalid(NativeError.INVALID_CONNECTION_ID);
        if (!matches(TOKEN, token)) invalid(NativeError.INVALID_TOKEN);
        if (!matches(DATE, date)) invalid(NativeError.INVALID_DATE);
        if (!matches(PROSODY, rate)) invalid(NativeError.INVALID_RATE);
        if (!matches(PROSODY, volume)) invalid(NativeError.INVALID_VOLUME);
        String ssml = SsmlBuilder.build(text, voice, rate, volume);
        if (ssml.getBytes(StandardCharsets.UTF_8).length > MAX_SSML_BYTES) invalid(NativeError.INVALID_SSML);
        return new Request(text, voice, connectionId, token, date, ssml);
    }

    private static boolean matches(Pattern pattern, String value) {
        return value != null && pattern.matcher(value).matches();
    }

    private static void invalid(NativeError error) throws NativeBoundaryException {
        throw new NativeBoundaryException(error);
    }
}
