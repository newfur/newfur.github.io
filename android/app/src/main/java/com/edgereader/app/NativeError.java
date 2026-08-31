package com.edgereader.app;

enum NativeError {
    INVALID_SOURCE_URI("Source URI is invalid"),
    SOURCE_NOT_ALLOWED("Source is not allowed"),
    SOURCE_NOT_FOUND("Source was not found"),
    INVALID_FILENAME("Filename is invalid"),
    DESTINATION_UNAVAILABLE("Destination is unavailable"),
    COPY_FAILED("Copy failed"),
    USER_CANCELLED("User cancelled"),
    INVALID_TEXT("TTS text is invalid"),
    INVALID_VOICE("TTS voice is invalid"),
    INVALID_CONNECTION_ID("TTS connection ID is invalid"),
    INVALID_TOKEN("TTS token is invalid"),
    INVALID_DATE("TTS timestamp is invalid"),
    INVALID_RATE("TTS rate is invalid"),
    INVALID_VOLUME("TTS volume is invalid"),
    INVALID_SSML("TTS request is too large"),
    PROTOCOL_ERROR("TTS protocol error"),
    INCOMPLETE_AUDIO("TTS audio response is incomplete"),
    EMPTY_AUDIO("No audio data received"),
    CANCELLED("TTS request was cancelled"),
    NOTIFICATION_PERMISSION_DENIED("Notification permission is denied");

    private final String message;

    NativeError(String message) { this.message = message; }

    String message() { return message; }
}
