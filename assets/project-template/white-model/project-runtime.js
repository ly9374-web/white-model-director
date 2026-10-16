const response = await fetch('../project.json');
if (!response.ok) throw new Error('无法读取 project.json');
export const PROJECT = await response.json();
