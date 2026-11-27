import type { ProjectStore } from '../../state';

export class DjiLibraryImporter {
  constructor(private readonly store: ProjectStore) {}

  async importLocalFile(localPath: string): Promise<string[]> {
    const created = await this.store.importFiles([localPath]);
    return created.map((a) => a.id);
  }
}
