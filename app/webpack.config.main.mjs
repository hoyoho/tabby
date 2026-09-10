import * as path from 'path'
import wp from 'webpack'
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer'
import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const config = {
    name: 'tabby-main',
    target: 'electron-main',
    entry: {
        main: path.resolve(__dirname, 'lib/index.ts'),
        // node-pty lives here (see lib/ptyHost.ts): an Electron utilityProcess
        // so a native ConPTY teardown crash cannot take the app down.
        ptyHost: path.resolve(__dirname, 'lib/ptyHost.ts'),
    },
    mode: process.env.TABBY_DEV ? 'development' : 'production',
    context: __dirname,
    devtool: 'source-map',
    output: {
        path: path.join(__dirname, 'dist'),
        pathinfo: true,
        filename: '[name].js',
    },
    resolve: {
        modules: ['lib/', 'node_modules', '../node_modules'].map(x => path.join(__dirname, x)),
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: {
                    loader: 'ts-loader',
                    options: {
                        configFile: path.resolve(__dirname, 'tsconfig.main.json'),
                    },
                },
            },
        ],
    },
    externals: {
        'any-promise': 'commonjs any-promise',
        electron: 'commonjs electron',
        'electron-config': 'commonjs electron-config',
        'electron-debug': 'commonjs electron-debug',
        'electron-promise-ipc': 'commonjs electron-promise-ipc',
        'electron-updater': 'commonjs electron-updater',
        fs: 'commonjs fs',
        glasstron: 'commonjs glasstron',
        mz: 'commonjs mz',
        '@npmcli/arborist': 'commonjs @npmcli/arborist',
        'win-ca': 'commonjs win-ca',
        'win-ca/api': 'commonjs win-ca/api',
        'mac-ca': 'commonjs mac-ca',
        'node:os': 'commonjs os',
        'node-pty': 'commonjs node-pty',
        '@serialport/bindings-cpp': 'commonjs @serialport/bindings-cpp',
        russh: 'commonjs russh',
        '@luminati-io/socksv5': 'commonjs @luminati-io/socksv5',
        path: 'commonjs path',
        util: 'commonjs util',
        'source-map-support': 'commonjs source-map-support',
        'windows-swca': 'commonjs windows-swca',
        'windows-native-registry': 'commonjs windows-native-registry',
        '@tabby-gang/windows-blurbehind': 'commonjs @tabby-gang/windows-blurbehind',
        'yargs/yargs': 'commonjs yargs/yargs',
    },
    plugins: [
        new wp.optimize.ModuleConcatenationPlugin(),
        new wp.DefinePlugin({
            'process.type': '"main"',
        }),
    ],
}

if (process.env.BUNDLE_ANALYZER) {
    config.plugins.push(new BundleAnalyzerPlugin())
}

export default () => config
