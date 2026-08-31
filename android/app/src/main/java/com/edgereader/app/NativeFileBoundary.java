package com.edgereader.app;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Path;
import java.nio.file.Files;

final class NativeFileBoundary {
    enum SourceKind { CONTENT, APP_FILE, REJECTED }

    private NativeFileBoundary() {}

    static boolean isWithin(File root, File candidate) throws IOException {
        Path rootPath = root.getCanonicalFile().toPath();
        Path candidatePath = candidate.getCanonicalFile().toPath();
        return candidatePath.startsWith(rootPath);
    }

    static boolean isApprovedFile(File cacheRoot, File filesRoot, File candidate) throws IOException {
        if (Files.isSymbolicLink(candidate.toPath())) return false;
        return isWithin(cacheRoot, candidate) || isWithin(filesRoot, candidate);
    }

    static SourceKind classifySource(File cacheRoot, File filesRoot, URI uri) throws IOException {
        if (uri == null || uri.getScheme() == null) return SourceKind.REJECTED;
        if ("content".equalsIgnoreCase(uri.getScheme())) return SourceKind.CONTENT;
        if (!"file".equalsIgnoreCase(uri.getScheme())) return SourceKind.REJECTED;
        return isApprovedFile(cacheRoot, filesRoot, new File(uri)) ? SourceKind.APP_FILE : SourceKind.REJECTED;
    }

    static boolean isSafeFilename(String value) {
        return value != null && !value.trim().isEmpty() && value.length() <= 255
                && !".".equals(value) && !"..".equals(value)
                && value.indexOf('/') < 0 && value.indexOf('\\') < 0 && value.indexOf('\0') < 0
                && value.equals(new File(value).getName());
    }
}
