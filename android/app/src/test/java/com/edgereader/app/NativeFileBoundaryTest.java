package com.edgereader.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class NativeFileBoundaryTest {
    @Rule public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void canonicalContainmentAcceptsRootAndChildrenButRejectsSiblingPrefix() throws Exception {
        File parent = temporaryFolder.newFolder("parent");
        File cache = new File(parent, "cache");
        File child = new File(cache, "staging/backup.zip");
        File sibling = new File(parent, "cache-other/backup.zip");
        assertTrue(cache.mkdirs());

        assertTrue(NativeFileBoundary.isWithin(cache, cache));
        assertTrue(NativeFileBoundary.isWithin(cache, child));
        assertFalse(NativeFileBoundary.isWithin(cache, sibling));
        assertFalse(NativeFileBoundary.isWithin(cache, new File(cache, "../cache-other/backup.zip")));
    }

    @Test
    public void approvedFilesAreLimitedToCanonicalCacheAndFilesRoots() throws Exception {
        File cache = temporaryFolder.newFolder("cache");
        File files = temporaryFolder.newFolder("files");
        File external = temporaryFolder.newFolder("external");

        assertTrue(NativeFileBoundary.isApprovedFile(cache, files, new File(cache, "backup.zip")));
        assertTrue(NativeFileBoundary.isApprovedFile(cache, files, new File(files, "backup.zip")));
        assertFalse(NativeFileBoundary.isApprovedFile(cache, files, new File(external, "backup.zip")));
    }

    @Test
    public void symlinkEscapeIsNotApproved() throws Exception {
        File cache = temporaryFolder.newFolder("cache");
        File files = temporaryFolder.newFolder("files");
        File external = temporaryFolder.newFolder("external");
        File secret = new File(external, "secret.zip");
        try (FileOutputStream output = new FileOutputStream(secret)) {
            output.write("secret".getBytes(StandardCharsets.UTF_8));
        }
        File link = new File(cache, "linked.zip");
        Files.createSymbolicLink(link.toPath(), secret.toPath());

        assertFalse(NativeFileBoundary.isApprovedFile(cache, files, link));
    }

    @Test
    public void symlinkInsideApprovedRootIsStillNotApproved() throws Exception {
        File cache = temporaryFolder.newFolder("cache");
        File files = temporaryFolder.newFolder("files");
        File target = new File(cache, "target.zip");
        Files.write(target.toPath(), new byte[] { 1 });
        File link = new File(cache, "linked.zip");
        Files.createSymbolicLink(link.toPath(), target.toPath());

        assertFalse(NativeFileBoundary.isApprovedFile(cache, files, link));
    }

    @Test
    public void symlinkDirectoryInsideApprovedRootIsNotApproved() throws Exception {
        File cache = temporaryFolder.newFolder("cache");
        File files = temporaryFolder.newFolder("files");
        File target = new File(cache, "target");
        Files.createDirectories(target.toPath());
        Files.write(new File(target, "backup.zip").toPath(), new byte[] { 1 });
        File link = new File(cache, "linked");
        Files.createSymbolicLink(link.toPath(), target.toPath());

        assertFalse(NativeFileBoundary.isApprovedFile(cache, files, new File(link, "backup.zip")));
    }

    @Test
    public void sourceClassificationAllowsContentAndApprovedFilesOnly() throws Exception {
        File cache = temporaryFolder.newFolder("cache");
        File files = temporaryFolder.newFolder("files");
        File approved = new File(cache, "backup.zip");
        File arbitrary = new File(temporaryFolder.newFolder("external"), "backup.zip");

        assertEquals(NativeFileBoundary.SourceKind.CONTENT,
                NativeFileBoundary.classifySource(cache, files, new URI("content://provider/document/1")));
        assertEquals(NativeFileBoundary.SourceKind.APP_FILE,
                NativeFileBoundary.classifySource(cache, files, approved.toURI()));
        assertEquals(NativeFileBoundary.SourceKind.REJECTED,
                NativeFileBoundary.classifySource(cache, files, arbitrary.toURI()));
        assertEquals(NativeFileBoundary.SourceKind.REJECTED,
                NativeFileBoundary.classifySource(cache, files, new URI("https://example.test/backup.zip")));
        assertEquals(NativeFileBoundary.SourceKind.REJECTED,
                NativeFileBoundary.classifySource(cache, files, new URI("/private/tmp/backup.zip")));
    }

    @Test
    public void filenameMustBeASafeBasename() {
        assertTrue(NativeFileBoundary.isSafeFilename("Edge Reader backup 1.zip"));
        assertFalse(NativeFileBoundary.isSafeFilename(null));
        assertFalse(NativeFileBoundary.isSafeFilename(""));
        assertFalse(NativeFileBoundary.isSafeFilename("   "));
        assertFalse(NativeFileBoundary.isSafeFilename("."));
        assertFalse(NativeFileBoundary.isSafeFilename(".."));
        assertFalse(NativeFileBoundary.isSafeFilename("../backup.zip"));
        assertFalse(NativeFileBoundary.isSafeFilename("dir/backup.zip"));
        assertFalse(NativeFileBoundary.isSafeFilename("dir\\backup.zip"));
        assertFalse(NativeFileBoundary.isSafeFilename("/absolute.zip"));
        assertFalse(NativeFileBoundary.isSafeFilename("bad\u0000name.zip"));
    }

    @Test
    public void errorsExposeStableCodeWithoutPrivateDetails() {
        NativeBoundaryException error = new NativeBoundaryException(
                NativeError.SOURCE_NOT_ALLOWED, new IOExceptionWithPrivatePath("/data/user/0/com.edgereader.app/cache/secret"));

        assertEquals("SOURCE_NOT_ALLOWED", error.getCode());
        assertEquals("Source is not allowed", error.getMessage());
        assertFalse(error.getMessage().contains("/data/user"));
    }

    private static final class IOExceptionWithPrivatePath extends Exception {
        IOExceptionWithPrivatePath(String message) { super(message); }
    }
}
