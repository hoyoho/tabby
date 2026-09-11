import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { writeFile } from 'atomically'


export const configPath = path.join(process.env.TABBY_CONFIG_DIRECTORY!, 'config.yaml')


export function loadConfig (): any {
    if (fs.existsSync(configPath)) {
        return yaml.load(fs.readFileSync(configPath, 'utf8'))
    } else {
        return {}
    }
}

export async function saveConfig (content: string): Promise<void> {
    await writeFile(configPath, content, { encoding: 'utf8' })
    await writeFile(configPath + '.backup', content, { encoding: 'utf8' })
}
