package com.edgereader.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

final class SafExportContract {
    private SafExportContract() {}

    static Uri requireDestination(ActivityResult result) throws NativeBoundaryException {
        if (result.getResultCode() != Activity.RESULT_OK) throw new NativeBoundaryException(NativeError.USER_CANCELLED);
        Intent data = result.getData();
        Uri destination = data == null ? null : data.getData();
        if (destination == null) throw new NativeBoundaryException(NativeError.DESTINATION_UNAVAILABLE);
        return destination;
    }

    static void write(ContentResolver resolver, Uri destination, InputStream input) throws NativeBoundaryException {
        try (OutputStream output = resolver.openOutputStream(destination)) {
            if (output == null) throw new NativeBoundaryException(NativeError.DESTINATION_UNAVAILABLE);
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        } catch (NativeBoundaryException error) {
            throw error;
        } catch (IOException | SecurityException error) {
            throw new NativeBoundaryException(NativeError.COPY_FAILED, error);
        }
    }
}
