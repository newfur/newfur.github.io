package com.edgereader.app;

import android.content.Context;
import android.net.Uri;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URISyntaxException;

final class NativeContentSource {
    private NativeContentSource() {}

    static InputStream open(Context context, String rawUri) throws NativeBoundaryException {
        if (rawUri == null || rawUri.isEmpty()) throw new NativeBoundaryException(NativeError.INVALID_SOURCE_URI);
        try {
            URI uri = new URI(rawUri);
            NativeFileBoundary.SourceKind kind = NativeFileBoundary.classifySource(context.getCacheDir(), context.getFilesDir(), uri);
            InputStream input;
            if (kind == NativeFileBoundary.SourceKind.CONTENT) input = context.getContentResolver().openInputStream(Uri.parse(rawUri));
            else if (kind == NativeFileBoundary.SourceKind.APP_FILE) input = new FileInputStream(new File(uri));
            else if (kind == NativeFileBoundary.SourceKind.INVALID) throw new NativeBoundaryException(NativeError.INVALID_SOURCE_URI);
            else throw new NativeBoundaryException(NativeError.SOURCE_NOT_ALLOWED);
            if (input == null) throw new NativeBoundaryException(NativeError.SOURCE_NOT_FOUND);
            return input;
        } catch (NativeBoundaryException error) {
            throw error;
        } catch (URISyntaxException | IllegalArgumentException error) {
            throw new NativeBoundaryException(NativeError.INVALID_SOURCE_URI, error);
        } catch (FileNotFoundException error) {
            throw new NativeBoundaryException(NativeError.SOURCE_NOT_FOUND, error);
        } catch (IOException | SecurityException error) {
            throw new NativeBoundaryException(NativeError.SOURCE_NOT_ALLOWED, error);
        }
    }
}
