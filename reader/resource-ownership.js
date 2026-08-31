export class ResourceOwnership {
  #owners = new Map();
  #urls = new Map();
  #releaseCallbacks = new Map();
  #revoked = new Set();

  constructor(urlApi = globalThis.URL, finalize = null) {
    this.urlApi = urlApi;
    this.finalize = finalize;
  }

  register(owner, url, onRelease = null) {
    if (owner == null || typeof url !== 'string' || !url.startsWith('blob:') || this.#revoked.has(url)) return url;
    let ownerUrls = this.#owners.get(owner);
    if (!ownerUrls) {
      ownerUrls = new Set();
      this.#owners.set(owner, ownerUrls);
    }
    if (ownerUrls.has(url)) return url;
    ownerUrls.add(url);

    let urlOwners = this.#urls.get(url);
    if (!urlOwners) {
      urlOwners = new Set();
      this.#urls.set(url, urlOwners);
    }
    urlOwners.add(owner);
    if (onRelease) {
      let callbacks = this.#releaseCallbacks.get(url);
      if (!callbacks) {
        callbacks = new Set();
        this.#releaseCallbacks.set(url, callbacks);
      }
      callbacks.add(onRelease);
    }
    return url;
  }

  has(owner, url) {
    return this.#owners.get(owner)?.has(url) || false;
  }

  transfer(fromOwner, toOwner, url = null) {
    const source = this.#owners.get(fromOwner);
    if (!source) return false;
    const urls = url == null ? [...source] : source.has(url) ? [url] : [];
    if (urls.length === 0) return false;
    urls.forEach(value => {
      this.register(toOwner, value);
      this.#detach(fromOwner, value);
    });
    return true;
  }

  release(owner, url) {
    if (!this.#owners.get(owner)?.has(url)) return false;
    this.#detach(owner, url);
    if (!this.#urls.has(url)) this.#release(url);
    return true;
  }

  revokeOwner(owner) {
    const urls = this.#owners.get(owner);
    if (!urls) return false;
    [...urls].forEach(url => {
      this.#detach(owner, url);
      if (!this.#urls.has(url)) this.#release(url);
    });
    return true;
  }

  revokeMatching(predicate) {
    [...this.#owners.keys()].forEach(owner => {
      if (predicate(owner)) this.revokeOwner(owner);
    });
  }

  revokeAll() {
    [...this.#owners.keys()].forEach(owner => this.revokeOwner(owner));
  }

  #detach(owner, url) {
    const ownerUrls = this.#owners.get(owner);
    if (ownerUrls) {
      ownerUrls.delete(url);
      if (ownerUrls.size === 0) this.#owners.delete(owner);
    }
    const urlOwners = this.#urls.get(url);
    if (urlOwners) {
      urlOwners.delete(owner);
      if (urlOwners.size === 0) this.#urls.delete(url);
    }
  }

  #release(url) {
    if (this.#revoked.has(url)) return;
    this.#revoked.add(url);
    const callbacks = this.#releaseCallbacks.get(url);
    this.#releaseCallbacks.delete(url);
    try {
      callbacks?.forEach(callback => callback(url));
      this.finalize?.(url);
    } finally {
      this.urlApi?.revokeObjectURL?.(url);
    }
  }
}

export function transferResourceOwner(resources, fromOwner, toOwner, ...targets) {
  const transferred = resources.transfer(fromOwner, toOwner);
  targets.forEach(target => {
    if (target) target.resourceOwner = toOwner;
  });
  return transferred;
}

export function revokeResourceOwners(resources, ...targets) {
  const owners = new Set(targets.map(target => target?.resourceOwner).filter(owner => owner != null));
  owners.forEach(owner => resources.revokeOwner(owner));
  targets.forEach(target => {
    if (target) target.resourceOwner = null;
  });
}

export async function withResourceOwner(resources, owner, operation) {
  try {
    return await operation();
  } finally {
    resources.revokeOwner(owner);
  }
}

export function cleanupOwnedResourceLists(resources, owner, ...lists) {
  const urls = new Set(lists.flatMap(list => Array.isArray(list) ? list : []));
  urls.forEach(url => resources.release(owner, url));
  lists.forEach(list => {
    if (Array.isArray(list)) list.splice(0);
  });
}

export class OwnedResourceSlot {
  constructor(resources) {
    this.resources = resources;
    this.owner = null;
  }

  replace(owner, replaceContent) {
    const previousOwner = this.owner;
    replaceContent();
    this.owner = owner;
    if (previousOwner != null && previousOwner !== owner) this.resources.revokeOwner(previousOwner);
  }

  clear(removeContent = null) {
    const previousOwner = this.owner;
    removeContent?.();
    this.owner = null;
    if (previousOwner != null) this.resources.revokeOwner(previousOwner);
  }
}

export class BoundedResourceCache extends Map {
  constructor(limit, resources) {
    super();
    this.limit = limit;
    this.resources = resources;
  }

  set(key, value) {
    const previous = this.get(key);
    if (previous?.owner != null && previous.owner !== value?.owner) this.resources.revokeOwner(previous.owner);
    if (this.has(key)) super.delete(key);
    super.set(key, value);
    while (this.size > this.limit) {
      const oldestKey = this.keys().next().value;
      this.delete(oldestKey);
    }
    return this;
  }

  delete(key) {
    const value = this.get(key);
    if (!super.delete(key)) return false;
    if (value?.owner != null) this.resources.revokeOwner(value.owner);
    return true;
  }

  clear() {
    [...this.keys()].forEach(key => this.delete(key));
  }

  take(key) {
    const value = this.get(key);
    if (value !== undefined) super.delete(key);
    return value;
  }
}
