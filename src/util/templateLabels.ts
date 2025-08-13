const templateMap: Record<string, string> = {
    nossa_historia: "Nossa História"
};

export function templateLabels(templateId: string): string | null {
    return templateMap[templateId] ?? null;
}
