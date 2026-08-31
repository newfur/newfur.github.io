package com.edgereader.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import androidx.activity.result.ActivityResult;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.atomic.AtomicBoolean;

final class NativeExportController {
    private final android.content.Context context;
    private final ContentResolver resolver;
    private final Uri downloadsCollection;
    private final AtomicBoolean pickerBusy = new AtomicBoolean();
    private String pendingSource;
    private String pendingFilename;

    NativeExportController(android.content.Context context) {
        this(context, Uri.parse("content://media/external/downloads"));
    }

    NativeExportController(android.content.Context context, Uri downloadsCollection) {
        this.context = context;
        this.resolver = context.getContentResolver();
        this.downloadsCollection = downloadsCollection;
    }

    Intent beginSaf(String rawSource, String filename) throws NativeBoundaryException {
        validate(rawSource, filename);
        try (InputStream ignored = NativeContentSource.open(context, rawSource)) {
            // Validate access before opening the system picker.
        } catch (NativeBoundaryException error) {
            throw error;
        } catch (IOException error) {
            throw new NativeBoundaryException(NativeError.SOURCE_NOT_FOUND, error);
        }
        if (!pickerBusy.compareAndSet(false, true)) {
            throw new NativeBoundaryException(NativeError.DESTINATION_UNAVAILABLE);
        }
        pendingSource = rawSource;
        pendingFilename = filename;
        return new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/zip")
                .putExtra(Intent.EXTRA_TITLE, filename);
    }

    String completeSaf(ActivityResult result) throws NativeBoundaryException {
        String source = pendingSource;
        String filename = pendingFilename;
        pendingSource = null;
        pendingFilename = null;
        pickerBusy.set(false);
        if (source == null || filename == null) throw new NativeBoundaryException(NativeError.DESTINATION_UNAVAILABLE);
        try {
            Uri destination = SafExportContract.requireDestination(result);
            try (InputStream input = NativeContentSource.open(context, source)) {
                SafExportContract.write(resolver, destination, input);
            }
            return destination.toString();
        } catch (NativeBoundaryException error) {
            throw error;
        } catch (Exception error) {
            throw new NativeBoundaryException(NativeError.COPY_FAILED, error);
        }
    }

    String copyToDownloads(String rawSource, String filename) throws NativeBoundaryException {
        validate(rawSource, filename);
        try (InputStream input = NativeContentSource.open(context, rawSource)) {
            PendingMediaStoreWrite.execute(new PendingMediaStoreWrite.Store() {
                Uri destination;

                @Override public void insertPending() throws IOException {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    destination = resolver.insert(downloadsCollection, values);
                    if (destination == null) throw new IOException("insert failed");
                }

                @Override public void write() throws IOException {
                    try (OutputStream output = resolver.openOutputStream(destination)) {
                        if (output == null) throw new IOException("destination unavailable");
                        copy(input, output);
                    }
                }

                @Override public boolean publish() {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    return resolver.update(destination, values, null, null) == 1;
                }

                @Override public void delete() { resolver.delete(destination, null, null); }
            });
            return Environment.DIRECTORY_DOWNLOADS + "/" + filename;
        } catch (NativeBoundaryException error) {
            throw error;
        } catch (Exception error) {
            throw new NativeBoundaryException(NativeError.COPY_FAILED, error);
        }
    }

    boolean hasPendingSaf() { return pickerBusy.get(); }

    void clear() {
        pendingSource = null;
        pendingFilename = null;
        pickerBusy.set(false);
    }

    private static void validate(String rawSource, String filename) throws NativeBoundaryException {
        if (!NativeFileBoundary.isSafeFilename(filename)) throw new NativeBoundaryException(NativeError.INVALID_FILENAME);
        if (rawSource == null || rawSource.isEmpty()) throw new NativeBoundaryException(NativeError.INVALID_SOURCE_URI);
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
    }
}
