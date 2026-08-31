package com.edgereader.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeNotificationStatusTest {
    @Test
    public void deniedPermissionReturnsExplicitStartedDegradedState() {
        NativeNotificationStatus status = NativeNotificationStatus.forPermission("denied", true);
        assertEquals("denied", status.permission);
        assertFalse(status.controlsAvailable);
        assertTrue(status.serviceStarted);
    }

    @Test
    public void grantedPermissionReturnsAvailableControls() {
        NativeNotificationStatus status = NativeNotificationStatus.forPermission("granted", true);
        assertEquals("granted", status.permission);
        assertTrue(status.controlsAvailable);
        assertTrue(status.serviceStarted);
    }
}
