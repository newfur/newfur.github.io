package com.edgereader.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import androidx.core.content.FileProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.Arrays;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class AppSecurityInstrumentedTest {
    @Test
    public void fileProviderExposesOnlyAppOwnedCacheAndFiles() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String authority = context.getPackageName() + ".fileprovider";
        File cacheFile = new File(context.getCacheDir(), "provider-test.zip");
        File filesFile = new File(context.getFilesDir(), "provider-test.zip");
        assertTrue(cacheFile.createNewFile() || cacheFile.isFile());
        assertTrue(filesFile.createNewFile() || filesFile.isFile());

        assertEquals("content", FileProvider.getUriForFile(context, authority, cacheFile).getScheme());
        assertEquals("content", FileProvider.getUriForFile(context, authority, filesFile).getScheme());
        try {
            FileProvider.getUriForFile(context, authority, new File(context.getExternalCacheDir(), "not-shared.zip"));
            fail("External cache must not be exposed by FileProvider");
        } catch (IllegalArgumentException expected) {
            assertNotNull(expected);
        } finally {
            cacheFile.delete();
            filesFile.delete();
        }
    }

    @Test
    public void notificationPermissionIsDeclared() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS);
        assertNotNull(info.requestedPermissions);
        assertTrue(Arrays.asList(info.requestedPermissions).contains(Manifest.permission.POST_NOTIFICATIONS));
    }
}
