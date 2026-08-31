package com.edgereader.app;

import java.io.IOException;

final class PendingMediaStoreWrite {
    interface Store {
        void insertPending() throws IOException;
        void write() throws IOException;
        boolean publish() throws IOException;
        void delete();
    }

    private PendingMediaStoreWrite() {}

    static void execute(Store store) throws IOException {
        boolean inserted = false;
        boolean published = false;
        try {
            store.insertPending();
            inserted = true;
            store.write();
            if (!store.publish()) throw new IOException("publish failed");
            published = true;
        } finally {
            if (inserted && !published) store.delete();
        }
    }
}
