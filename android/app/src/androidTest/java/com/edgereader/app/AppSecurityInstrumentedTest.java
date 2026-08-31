package com.edgereader.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
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

    @Test
    public void grantedContentUriCanBeReadAndWrittenThroughResolver() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Uri uri = Uri.parse("content://com.edgereader.app.native-test-provider/document");
        grantProviderUri(context, uri);
        try (InputStream input = context.getContentResolver().openInputStream(uri)) {
            assertNotNull(input);
            assertEquals(1, input.read());
        }
        try (OutputStream output = context.getContentResolver().openOutputStream(uri, "w")) {
            assertNotNull(output);
            output.write(new byte[] { 4, 5 });
        }
    }

    @Test
    public void nativeContentSourceOpensGrantedProviderUri() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Uri uri = Uri.parse("content://com.edgereader.app.native-test-provider/source");
        grantProviderUri(context, uri);
        try (InputStream input = NativeContentSource.open(context, uri.toString())) {
            assertEquals(1, input.read());
        }
    }

    @Test
    public void safContractMapsCancelAndWritesPickerDestination() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try {
            SafExportContract.requireDestination(new ActivityResult(Activity.RESULT_CANCELED, null));
            fail("Expected cancellation");
        } catch (NativeBoundaryException error) {
            assertEquals("USER_CANCELLED", error.getCode());
        }

        Uri uri = Uri.parse("content://com.edgereader.app.native-test-provider/destination");
        Intent resultData = new Intent().setData(uri);
        Uri destination = SafExportContract.requireDestination(new ActivityResult(Activity.RESULT_OK, resultData));
        SafExportContract.write(context.getContentResolver(), destination, new java.io.ByteArrayInputStream(new byte[] { 7, 8 }));
        try (InputStream input = context.getContentResolver().openInputStream(uri)) {
            assertEquals(7, input.read());
            assertEquals(8, input.read());
        }
    }

    @Test
    public void safContractMapsMissingDestinationWithoutPrivateDetails() throws Exception {
        try {
            SafExportContract.requireDestination(new ActivityResult(Activity.RESULT_OK, new Intent()));
            fail("Expected missing destination");
        } catch (NativeBoundaryException error) {
            assertEquals("DESTINATION_UNAVAILABLE", error.getCode());
            assertEquals("Destination is unavailable", error.getMessage());
        }
    }

    @Test
    public void pendingResolverRowIsDeletedWhenPublicationFails() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Uri collection = Uri.parse("content://com.edgereader.app.native-test-provider/downloads");
        grantProviderUri(context, collection);
        NativeTestProvider.deletes = 0;
        NativeTestProvider.updates = 0;
        NativeTestProvider.failPublish = true;
        try {
            PendingMediaStoreWrite.execute(new PendingMediaStoreWrite.Store() {
                Uri destination;
                @Override public void insertPending() throws java.io.IOException {
                    destination = context.getContentResolver().insert(collection, new android.content.ContentValues());
                    if (destination == null) throw new java.io.IOException("insert failed");
                }
                @Override public void write() throws java.io.IOException {
                    try (OutputStream output = context.getContentResolver().openOutputStream(destination, "w")) {
                        if (output == null) throw new java.io.IOException("open failed");
                        output.write(9);
                    }
                }
                @Override public boolean publish() {
                    return context.getContentResolver().update(destination, new android.content.ContentValues(), null, null) == 1;
                }
                @Override public void delete() { context.getContentResolver().delete(destination, null, null); }
            });
            fail("Expected publication failure");
        } catch (java.io.IOException expected) {
            assertEquals(1, NativeTestProvider.updates);
            assertEquals(1, NativeTestProvider.deletes);
        } finally {
            NativeTestProvider.failPublish = false;
        }
    }

    private static void grantProviderUri(Context targetContext, Uri uri) {
        Context testContext = InstrumentationRegistry.getInstrumentation().getContext();
        testContext.grantUriPermission(targetContext.getPackageName(), uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
    }
}
