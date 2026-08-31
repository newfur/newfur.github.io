package com.edgereader.app;

enum NativeError {
    INVALID_SOURCE_URI("Source URI is invalid"),
    SOURCE_NOT_ALLOWED("Source is not allowed"),
    SOURCE_NOT_FOUND("Source was not found"),
    INVALID_FILENAME("Filename is invalid"),
    DESTINATION_UNAVAILABLE("Destination is unavailable"),
    COPY_FAILED("Copy failed"),
    USER_CANCELLED("User cancelled");

    private final String message;

    NativeError(String message) { this.message = message; }

    String message() { return message; }
}
