const templateMap: Record<string, string> = {
    nossa_historia: "Nossa História",
    infinito_particular: "Infinito Particular",
    bem_vindo_ao_mundo: "Bem-vindo ao Mundo"
};

export function templateLabels(templateId: string): string {
    return templateMap[templateId] ?? templateId;
}
