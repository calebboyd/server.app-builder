import { parse } from 'subtext'
import { createAnnotationFactory } from 'reflect-annotations'

export class ParseBodyAnnotation {
  public isBodyParser = true
  constructor (public options:{
      parse: boolean,
      output: 'data' | 'stream' | 'file',
      maxBytes?: number,
      override?: string,
      defaultContentType?: string,
      allow?: string,
      timeout?: number
      qs?: Object,
      uploads?: string,
      decoders?: { [key: string]: Function },
      compression?: { [key: string]: Function }
    } = { parse: true, output: 'data' }) {}

  get parser() {
    const options = this.options
    return (context: any, next: () => Promise<any>) => {
      return new Promise((resolve, reject) => {
        parse(context.req, null, options, (err, result) => {
          if (err) {
            return reject(err)
          }
          context.router.bodyResult = result
          context.req.body = result.payload
          resolve(next())
        })
      })
    }
  }
}

export const ParseBody = createAnnotationFactory(ParseBodyAnnotation)

export const parseJsonBody = new ParseBodyAnnotation()