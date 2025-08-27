const templateMap: Record<string, string> = {
    nossa_historia: "Nossa História",
    infinito_particular: "Infinito Particular"
};

export function templateLabels(templateId: string): string {
    return templateMap[templateId] ?? templateId;
}
