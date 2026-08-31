package com.edgereader.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import java.io.IOException;
import org.junit.Test;

public class PendingMediaStoreWriteTest {
    @Test
    public void deletesInsertedRowWhenWriteFails() throws Exception {
        FakeStore store = new FakeStore();
        store.writeFailure = true;
        assertFails(store);
        assertEquals(1, store.deletes);
    }

    @Test
    public void deletesInsertedRowWhenPublishFailsOrReturnsFalse() throws Exception {
        FakeStore throwing = new FakeStore();
        throwing.publishFailure = true;
        assertFails(throwing);
        assertEquals(1, throwing.deletes);

        FakeStore falsePublish = new FakeStore();
        falsePublish.publishResult = false;
        assertFails(falsePublish);
        assertEquals(1, falsePublish.deletes);
    }

    @Test
    public void keepsRowOnlyAfterSuccessfulPublication() throws Exception {
        FakeStore store = new FakeStore();
        PendingMediaStoreWrite.execute(store);
        assertEquals(0, store.deletes);
        assertEquals(1, store.publishes);
    }

    private static void assertFails(FakeStore store) throws Exception {
        try {
            PendingMediaStoreWrite.execute(store);
            fail("Expected failure");
        } catch (IOException expected) {
            // Expected.
        }
    }

    private static final class FakeStore implements PendingMediaStoreWrite.Store {
        int deletes;
        int publishes;
        boolean writeFailure;
        boolean publishFailure;
        boolean publishResult = true;

        @Override public void insertPending() {}
        @Override public void write() throws IOException { if (writeFailure) throw new IOException("write"); }
        @Override public boolean publish() throws IOException {
            publishes++;
            if (publishFailure) throw new IOException("publish");
            return publishResult;
        }
        @Override public void delete() { deletes++; }
    }
}
