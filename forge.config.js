const path = require('path');

module.exports = {
	packagerConfig: {
		asar: true,
		ignore: [
			'^/docs$', '^/scripts$', '^/out$', '^/.vscode$',
			'^/app/modules/nui_wc2/.git$', '^/app/modules/electron_helper/.git$',
			'^/app/modules/nui_wc2/Playground$'
		],
		extraResource: ['config.json'],
		executableName: 'nmarkdownviewer',
		icon: path.join(__dirname, 'build', 'icons', 'nui-icon-app-fullscreen.ico')
	},
	rebuildConfig: {},
	makers: [
		{
			name: '@electron-forge/maker-squirrel',
			config: {
				name: 'nmarkdownviewer',
				setupExe: 'nmarkdownviewer_setup.exe',
				setupIcon: path.join(__dirname, 'build', 'icons', 'nui-icon-installer.ico')
			}
		},
		{
			name: '@electron-forge/maker-zip'
		}
	]
};
