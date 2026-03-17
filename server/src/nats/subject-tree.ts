import type { SubjectNode } from 'shared';

interface SubjectStats {
  messageCount: number;
  lastMessage?: any;
  recentTimestamps: number[];
}

export function buildSubjectTree(stats: Map<string, SubjectStats>): SubjectNode[] {
  const root: SubjectNode[] = [];

  for (const [subject, stat] of stats) {
    const segments = subject.split('.');
    let currentLevel = root;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const fullSubject = segments.slice(0, i + 1).join('.');

      let node = currentLevel.find(n => n.segment === segment);
      if (!node) {
        const now = Date.now();
        const rate = stat.recentTimestamps.filter(t => now - t < 10000).length / 10;
        node = {
          segment,
          fullSubject,
          messageCount: 0,
          children: [],
          rate: i === segments.length - 1 ? rate : 0,
        };
        currentLevel.push(node);
      }

      if (i === segments.length - 1) {
        node.messageCount = stat.messageCount;
        node.lastMessage = stat.lastMessage;
        const now = Date.now();
        node.rate = stat.recentTimestamps.filter(t => now - t < 10000).length / 10;
      }

      currentLevel = node.children;
    }
  }

  // Sort nodes alphabetically
  const sortNodes = (nodes: SubjectNode[]) => {
    nodes.sort((a, b) => a.segment.localeCompare(b.segment));
    nodes.forEach(n => sortNodes(n.children));
  };
  sortNodes(root);

  return root;
}
