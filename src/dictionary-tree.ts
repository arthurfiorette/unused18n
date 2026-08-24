import type {
  DictionaryKeySource,
  DictionaryRemovalBarrier,
  DictionarySourceProperty
} from './dictionary.js';

interface TreeNode {
  readonly children: Map<string, TreeNode>;
  readonly parent?: TreeNode;
  readonly segment?: string;
  previous?: TreeNode;
  next?: TreeNode;
  source?: DictionaryKeySource;
}

/** Mutable active dictionary state with subtree work scoped to the selected path. */
export class ActiveDictionaryTree {
  readonly #root: TreeNode = { children: new Map() };
  #first: TreeNode | undefined;
  #last: TreeNode | undefined;

  set(path: readonly string[], source: DictionaryKeySource): void {
    const node = this.#node(path, true);
    if (!node) return;
    if (!node.source) {
      if (this.#last) {
        this.#last.next = node;
        node.previous = this.#last;
      } else {
        this.#first = node;
      }
      this.#last = node;
    }
    node.source = source;
  }

  has(path: readonly string[]): boolean {
    return this.#node(path, false)?.source !== undefined;
  }

  hasSubtree(path: readonly string[]): boolean {
    const node = this.#node(path, false);
    return node !== undefined && (node.source !== undefined || node.children.size > 0);
  }

  deleteSubtree(path: readonly string[]): void {
    if (path.length === 0) {
      this.#root.children.clear();
      delete this.#root.source;
      this.#first = undefined;
      this.#last = undefined;
      return;
    }

    let node = this.#root;
    let parent: TreeNode | undefined;
    let segment: string | undefined;
    for (const currentSegment of normalizedSegments(path)) {
      const child = node.children.get(currentSegment);
      if (!child) return;
      parent = node;
      segment = currentSegment;
      node = child;
    }
    if (!parent || segment === undefined) return;
    const pending = [node];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      if (current.source) this.#removeActive(current);
      for (const child of current.children.values()) pending.push(child);
    }
    parent.children.delete(segment);
  }

  addBarrier(path: readonly string[], barrier: DictionaryRemovalBarrier): void {
    const node = this.#node(path, false);
    if (!node) return;

    const pending = [node];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      if (current.source) current.source = sourceWithBarrier(current.source, barrier);
      for (const child of current.children.values()) pending.push(child);
    }
  }

  toKeySources(): Map<string, DictionaryKeySource> {
    const keySources = new Map<string, DictionaryKeySource>();
    let node = this.#first;
    while (node) {
      if (node.source) keySources.set(materializePath(node), node.source);
      node = node.next;
    }
    return keySources;
  }

  #node(path: readonly string[], create: boolean): TreeNode | undefined {
    let node = this.#root;
    for (const segment of normalizedSegments(path)) {
      let child = node.children.get(segment);
      if (!child) {
        if (!create) return undefined;
        child = { children: new Map(), parent: node, segment };
        node.children.set(segment, child);
      }
      node = child;
    }
    return node;
  }

  #removeActive(node: TreeNode): void {
    if (node.previous) {
      if (node.next) node.previous.next = node.next;
      else delete node.previous.next;
    } else {
      this.#first = node.next;
    }
    if (node.next) {
      if (node.previous) node.next.previous = node.previous;
      else delete node.next.previous;
    } else {
      this.#last = node.previous;
    }
    delete node.previous;
    delete node.next;
    delete node.source;
  }
}

function* normalizedSegments(path: readonly string[]): Generator<string> {
  for (const segment of path) {
    let start = 0;
    let separator = segment.indexOf('.');
    if (separator < 0) {
      yield segment;
      continue;
    }
    while (separator >= 0) {
      yield segment.slice(start, separator);
      start = separator + 1;
      separator = segment.indexOf('.', start);
    }
    yield segment.slice(start);
  }
}

function materializePath(node: TreeNode): string {
  const segments: string[] = [];
  let current: TreeNode | undefined = node;
  while (current?.parent) {
    segments.push(current.segment ?? '');
    current = current.parent;
  }
  segments.reverse();
  return segments.join('.');
}

function sourceWithBarrier(
  source: DictionaryKeySource,
  barrier: DictionaryRemovalBarrier
): DictionaryKeySource {
  let changed = false;
  const propertyChain = source.propertyChain.map((property) => {
    const next = propertyWithBarrier(property, barrier);
    if (next !== property) changed = true;
    return next;
  });
  return changed ? { ...source, propertyChain } : source;
}

function propertyWithBarrier(
  property: DictionarySourceProperty,
  barrier: DictionaryRemovalBarrier
): DictionarySourceProperty {
  return property.barriers.includes(barrier)
    ? property
    : { ...property, barriers: [...property.barriers, barrier] };
}
