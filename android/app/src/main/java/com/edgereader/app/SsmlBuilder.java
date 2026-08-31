package com.edgereader.app;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class SsmlBuilder {
    private static final Pattern VOICE_LOCALE = Pattern.compile("^([A-Za-z]{2,3})-([A-Za-z]{2}|[0-9]{3})(?:-|$)");

    private SsmlBuilder() {}

    static String build(String text, String voice, String rate, String volume) {
        String safeVoice = escape(voice == null ? "" : voice);
        String safeRate = escape(rate == null ? "+0%" : rate);
        String safeVolume = escape(volume == null ? "+0%" : volume);
        return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + locale(voice) + "'>"
                + "<voice name='" + safeVoice + "'><prosody pitch='+0Hz' rate='" + safeRate + "' volume='" + safeVolume + "'>"
                + escape(normalizeText(text)) + "</prosody></voice></speak>";
    }

    static String normalizeText(String text) {
        if (text == null) return "";
        return text.replaceAll("[\\p{Cc}&&[^\\r\\n\\t]]", "").replaceAll("\\s+", " ").trim();
    }

    private static String locale(String voice) {
        Matcher matcher = VOICE_LOCALE.matcher(voice == null ? "" : voice);
        return matcher.find() ? matcher.group(1).toLowerCase() + "-" + matcher.group(2).toUpperCase() : "und";
    }

    private static String escape(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;");
    }
}
