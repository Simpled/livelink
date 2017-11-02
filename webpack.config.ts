import * as path from 'path';
import { Configuration, LoaderOptionsPlugin } from 'webpack';

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

const config: Configuration = {
  devtool: isProd ? 'hidden-source-map' : 'source-map',
  context: path.resolve('./src'),
  entry: {
    livelink: './index',
  },
  module: {
    rules: [
      {
        test: /\.ts?$/,
        exclude: ['node_modules'],
        use: ['awesome-typescript-loader', 'source-map-loader'],
      },
    ],
  },
  output: {
    path: path.resolve('./dist'),
    filename: '[name].bundle.js',
    sourceMapFilename: '[name].bundle.map',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  plugins: [
    new LoaderOptionsPlugin({
      options: {
        tslint: {
          emitErrors: true,
          failOnHint: true,
        },
      },
    }),
  ],
};

export default config;
