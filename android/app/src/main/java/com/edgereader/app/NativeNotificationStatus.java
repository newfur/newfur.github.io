package com.edgereader.app;

final class NativeNotificationStatus {
    final String permission;
    final boolean controlsAvailable;
    final boolean serviceStarted;

    private NativeNotificationStatus(String permission, boolean controlsAvailable, boolean serviceStarted) {
        this.permission = permission;
        this.controlsAvailable = controlsAvailable;
        this.serviceStarted = serviceStarted;
    }

    static NativeNotificationStatus forPermission(String permission, boolean serviceStarted) {
        return new NativeNotificationStatus(permission, "granted".equals(permission), serviceStarted);
    }
}
