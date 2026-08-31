package com.edgereader.app;

import java.io.File;
import java.io.IOException;
import java.net.URI;

final class NativeFileBoundary {
    enum SourceKind { CONTENT, APP_FILE, INVALID, REJECTED }

    private NativeFileBoundary() {}

    static boolean isWithin(File root, File candidate) throws IOException {
        String rootPath = root.getCanonicalPath();
        String candidatePath = candidate.getCanonicalPath();
        return candidatePath.equals(rootPath) || candidatePath.startsWith(rootPath + File.separator);
    }

    static boolean isApprovedFile(File cacheRoot, File filesRoot, File candidate) throws IOException {
        return isWithinWithoutSymlinks(cacheRoot, candidate) || isWithinWithoutSymlinks(filesRoot, candidate);
    }

    private static boolean isWithinWithoutSymlinks(File root, File candidate) throws IOException {
        File absoluteRoot = root.getAbsoluteFile();
        File absoluteCandidate = candidate.getAbsoluteFile();
        String rootPath = absoluteRoot.getPath();
        String candidatePath = absoluteCandidate.getPath();
        if (!(candidatePath.equals(rootPath) || candidatePath.startsWith(rootPath + File.separator)) || !isWithin(root, candidate)) {
            return false;
        }
        String relative = candidatePath.substring(rootPath.length());
        File current = root.getCanonicalFile();
        for (String component : relative.split(java.util.regex.Pattern.quote(File.separator))) {
            if (component.isEmpty()) continue;
            if (".".equals(component) || "..".equals(component)) return false;
            File lexical = new File(current, component);
            File canonical = lexical.getCanonicalFile();
            if (!lexical.getAbsolutePath().equals(canonical.getAbsolutePath())) return false;
            current = canonical;
        }
        return true;
    }

    static SourceKind classifySource(File cacheRoot, File filesRoot, URI uri) throws IOException {
        if (uri == null || uri.getScheme() == null) return SourceKind.REJECTED;
        if ("content".equalsIgnoreCase(uri.getScheme())) return SourceKind.CONTENT;
        if (!"file".equalsIgnoreCase(uri.getScheme())) return SourceKind.REJECTED;
        if (uri.getRawAuthority() != null && !uri.getRawAuthority().isEmpty()) return SourceKind.INVALID;
        try {
            return isApprovedFile(cacheRoot, filesRoot, new File(uri)) ? SourceKind.APP_FILE : SourceKind.REJECTED;
        } catch (IllegalArgumentException error) {
            return SourceKind.INVALID;
        }
    }

    static boolean isSafeFilename(String value) {
        return value != null && !value.trim().isEmpty() && value.length() <= 255
                && !".".equals(value) && !"..".equals(value)
                && value.indexOf('/') < 0 && value.indexOf('\\') < 0 && value.indexOf('\0') < 0
                && value.equals(new File(value).getName());
    }
}
