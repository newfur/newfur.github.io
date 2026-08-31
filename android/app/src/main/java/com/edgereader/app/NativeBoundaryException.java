package com.edgereader.app;

final class NativeBoundaryException extends Exception {
    private final NativeError error;

    NativeBoundaryException(NativeError error) { super(error.message()); this.error = error; }

    NativeBoundaryException(NativeError error, Throwable cause) {
        super(error.message(), cause);
        this.error = error;
    }

    String getCode() { return error.name(); }
}
